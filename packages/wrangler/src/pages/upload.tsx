import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { render, Text } from "ink";
import Spinner from "ink-spinner";
import PQueue from "p-queue";
import React from "react";
import { fetchResult } from "../cfetch";
import { FatalError } from "../errors";
import isInteractive from "../is-interactive";
import { logger } from "../logger";
import {
	BULK_UPLOAD_CONCURRENCY,
	MAX_BUCKET_FILE_COUNT,
	MAX_BUCKET_SIZE,
	MAX_CHECK_MISSING_ATTEMPTS,
	MAX_UPLOAD_ATTEMPTS,
} from "./constants";
import { ApiErrorCodes } from "./errors";
import { validate } from "./validate";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";
import type { UploadPayloadFile } from "./types";
import type { FileContainer } from "./validate";

type UploadArgs = StrictYargsOptionsToInterface<typeof Options>;

export function Options(yargs: CommonYargsArgv) {
	return yargs
		.positional("directory", {
			type: "string",
			demandOption: true,
			description: "The directory of static files to upload",
		})
		.options({
			"output-manifest-path": {
				type: "string",
				description: "The name of the project you want to deploy to",
			},
			"skip-caching": {
				type: "boolean",
				description: "Skip asset caching which speeds up builds",
			},
		});
}

export const Handler = async ({
	directory,
	outputManifestPath,
	skipCaching,
}: UploadArgs) => {
	if (!directory) {
		throw new FatalError("Must specify a directory.", 1);
	}

	if (!process.env.CF_PAGES_UPLOAD_JWT) {
		throw new FatalError("No JWT given.", 1);
	}

	const fileMap = await validate({ directory });

	const manifest = await upload({
		fileMap,
		jwt: process.env.CF_PAGES_UPLOAD_JWT,
		skipCaching: skipCaching ?? false,
	});

	if (outputManifestPath) {
		await mkdir(dirname(outputManifestPath), { recursive: true });
		await writeFile(outputManifestPath, JSON.stringify(manifest));
	}

	logger.log(`✨ Upload complete!`);
};

export const upload = async (
	args:
		| {
				fileMap: Map<string, FileContainer>;
				jwt: string;
				skipCaching: boolean;
		  }
		| {
				fileMap: Map<string, FileContainer>;
				accountId: string;
				projectName: string;
				skipCaching: boolean;
		  }
) => {
	async function fetchJwt(): Promise<string> {
		if ("jwt" in args) {
			return args.jwt;
		} else {
			return (
				await fetchResult<{ jwt: string }>(
					`/accounts/${args.accountId}/pages/projects/${args.projectName}/upload-token`
				)
			).jwt;
		}
	}

	const files = [...args.fileMap.values()];

	let jwt = await fetchJwt();

	const start = Date.now();

	let attempts = 0;
	const getMissingHashes = async (skipCaching: boolean): Promise<string[]> => {
		if (skipCaching) {
			logger.debug("Force skipping cache");
			return files.map(({ hash }) => hash);
		}

		try {
			return await fetchResult<string[]>(`/pages/assets/check-missing`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({
					hashes: files.map(({ hash }) => hash),
				}),
			});
		} catch (e) {
			if (attempts < MAX_CHECK_MISSING_ATTEMPTS) {
				// Exponential backoff, 1 second first time, then 2 second, then 4 second etc.
				await new Promise((resolvePromise) =>
					setTimeout(resolvePromise, Math.pow(2, attempts++) * 1000)
				);

				if (
					(e as { code: number }).code === ApiErrorCodes.UNAUTHORIZED ||
					isJwtExpired(jwt)
				) {
					// Looks like the JWT expired, fetch another one
					jwt = await fetchJwt();
				}
				return getMissingHashes(skipCaching);
			} else {
				throw e;
			}
		}
	};
	const missingHashes = await getMissingHashes(args.skipCaching);

	const sortedFiles = files
		.filter((file) => missingHashes.includes(file.hash))
		.sort((a, b) => b.sizeInBytes - a.sizeInBytes);

	// Start with a few buckets so small projects still get
	// the benefit of multiple upload streams
	const buckets: {
		files: FileContainer[];
		remainingSize: number;
	}[] = new Array(BULK_UPLOAD_CONCURRENCY).fill(null).map(() => ({
		files: [],
		remainingSize: MAX_BUCKET_SIZE,
	}));

	let bucketOffset = 0;
	for (const file of sortedFiles) {
		let inserted = false;

		for (let i = 0; i < buckets.length; i++) {
			// Start at a different bucket for each new file
			const bucket = buckets[(i + bucketOffset) % buckets.length];
			if (
				bucket.remainingSize >= file.sizeInBytes &&
				bucket.files.length < MAX_BUCKET_FILE_COUNT
			) {
				bucket.files.push(file);
				bucket.remainingSize -= file.sizeInBytes;
				inserted = true;
				break;
			}
		}

		if (!inserted) {
			buckets.push({
				files: [file],
				remainingSize: MAX_BUCKET_SIZE - file.sizeInBytes,
			});
		}
		bucketOffset++;
	}

	let counter = args.fileMap.size - sortedFiles.length;
	const { rerender, unmount } = renderProgress(counter, args.fileMap.size);

	const queue = new PQueue({ concurrency: BULK_UPLOAD_CONCURRENCY });

	for (const bucket of buckets) {
		// Don't upload empty buckets (can happen for tiny projects)
		if (bucket.files.length === 0) continue;

		attempts = 0;
		const doUpload = async (): Promise<void> => {
			// Populate the payload only when actually uploading (this is limited to 3 concurrent uploads at 50 MiB per bucket meaning we'd only load in a max of ~150 MiB)
			// This is so we don't run out of memory trying to upload the files.
			const payload: UploadPayloadFile[] = await Promise.all(
				bucket.files.map(async (file) => ({
					key: file.hash,
					value: (await readFile(file.path)).toString("base64"),
					metadata: {
						contentType: file.contentType,
					},
					base64: true,
				}))
			);

			try {
				logger.debug("POST /pages/assets/upload");
				const res = await fetchResult(`/pages/assets/upload`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${jwt}`,
					},
					body: JSON.stringify(payload),
				});
				logger.debug("result:", res);
			} catch (e) {
				if (attempts < MAX_UPLOAD_ATTEMPTS) {
					logger.debug("failed:", e, "retrying...");
					// Exponential backoff, 1 second first time, then 2 second, then 4 second etc.
					await new Promise((resolvePromise) =>
						setTimeout(resolvePromise, Math.pow(2, attempts) * 1000)
					);

					if (
						(e as { code: number }).code === ApiErrorCodes.UNAUTHORIZED ||
						isJwtExpired(jwt)
					) {
						// Looks like the JWT expired, fetch another one
						jwt = await fetchJwt();
					} else {
						// Only count as a failed attempt if the error _wasn't_ an expired JWT
						attempts++;
					}
					return doUpload();
				} else {
					logger.debug("failed:", e);
					throw e;
				}
			}
		};

		void queue.add(() =>
			doUpload().then(
				() => {
					counter += bucket.files.length;
					rerender(counter, args.fileMap.size);
				},
				(error) => {
					return Promise.reject(
						new FatalError(
							`Failed to upload files. Please try again. Error: ${JSON.stringify(
								error
							)})`,
							error.code || 1
						)
					);
				}
			)
		);
	}

	await queue.onIdle();

	unmount();

	const uploadMs = Date.now() - start;

	const skipped = args.fileMap.size - missingHashes.length;
	const skippedMessage = skipped > 0 ? `(${skipped} already uploaded) ` : "";

	logger.log(
		`✨ Success! Uploaded ${
			sortedFiles.length
		} files ${skippedMessage}${formatTime(uploadMs)}\n`
	);

	const doUpsertHashes = async (): Promise<void> => {
		try {
			return await fetchResult(`/pages/assets/upsert-hashes`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({
					hashes: files.map(({ hash }) => hash),
				}),
			});
		} catch (e) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));

			if (
				(e as { code: number }).code === ApiErrorCodes.UNAUTHORIZED ||
				isJwtExpired(jwt)
			) {
				// Looks like the JWT expired, fetch another one
				jwt = await fetchJwt();
			}

			return await fetchResult(`/pages/assets/upsert-hashes`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({
					hashes: files.map(({ hash }) => hash),
				}),
			});
		}
	};

	try {
		await doUpsertHashes();
	} catch {
		logger.warn(
			"Failed to update file hashes. Every upload appeared to succeed for this deployment, but you might need to re-upload for future deployments. This shouldn't have any impact other than slowing the upload speed of your next deployment."
		);
	}

	return Object.fromEntries(
		[...args.fileMap.entries()].map(([fileName, file]) => [
			`/${fileName}`,
			file.hash,
		])
	);
};

// Decode and check that the current JWT has not expired
function isJwtExpired(token: string): boolean | undefined {
	try {
		const decodedJwt = JSON.parse(
			Buffer.from(token.split(".")[1], "base64").toString()
		);

		const dateNow = new Date().getTime() / 1000;

		return decodedJwt.exp <= dateNow;
	} catch (e) {
		if (e instanceof Error) {
			throw new Error(`Invalid token: ${e.message}`);
		}
	}
}

function formatTime(duration: number) {
	return `(${(duration / 1000).toFixed(2)} sec)`;
}

function renderProgress(done: number, total: number) {
	if (isInteractive()) {
		const { rerender, unmount } = render(
			<Progress done={done} total={total} />
		);
		return {
			// eslint-disable-next-line no-shadow
			rerender(done: number, total: number) {
				rerender(<Progress done={done} total={total} />);
			},
			unmount,
		};
	} else {
		// eslint-disable-next-line no-shadow
		const rerender = (done: number, total: number) => {
			logger.log(`Uploading... (${done}/${total})`);
		};
		rerender(done, total);
		return { rerender, unmount() {} };
	}
}

function Progress({ done, total }: { done: number; total: number }) {
	return (
		<>
			<Text>
				{isInteractive() ? <Spinner type="earth" /> : null}
				{` Uploading... (${done}/${total})\n`}
			</Text>
		</>
	);
}
