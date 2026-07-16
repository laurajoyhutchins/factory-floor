import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  ArtifactBlobStoreError,
  S3ArtifactBlobStore as BaseS3ArtifactBlobStore,
  validateDigest,
  validateStagingId,
  type CommittedReceipt,
  type HexSha256Digest,
  type StageOptions,
  type StagingId,
  type StagingReceipt,
} from './index.js';

interface ObjectMetadata {
  readonly digest: string;
  readonly size: bigint;
}

interface S3Internals {
  readonly client: S3Client;
  readonly bucket: string;
  stagingKey(stagingId: string): string;
  committedKey(digest: string): string;
  locator(key: string): string;
  objectExists(key: string): Promise<boolean>;
  readVerifiedMetadata(
    key: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<ObjectMetadata>;
  headObject(
    key: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<{ Metadata?: Record<string, string> }>;
  getReadable(
    key: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<Readable>;
}

class DigestAccumulator {
  private readonly hash = createHash('sha256');
  private size = 0n;

  update(chunk: unknown): Buffer {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    this.hash.update(bytes);
    this.size += BigInt(bytes.length);
    return bytes;
  }

  result(): ObjectMetadata {
    return { digest: this.hash.digest('hex'), size: this.size };
  }
}

function createDigestMeter(): {
  readonly stream: Transform;
  readonly result: () => ObjectMetadata;
} {
  const accumulator = new DigestAccumulator();
  return {
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, accumulator.update(chunk));
      },
    }),
    result: () => accumulator.result(),
  };
}

function objectMetadata(metadata: ObjectMetadata): Record<string, string> {
  return {
    digest: metadata.digest,
    size: metadata.size.toString(),
    format: 'factory-floor-artifact-blob',
    version: '1',
  };
}

function parseMetadata(
  metadata: Record<string, string> | undefined,
  code: ArtifactBlobStoreError['code'],
): ObjectMetadata {
  if (
    metadata?.format !== 'factory-floor-artifact-blob' ||
    metadata.version !== '1' ||
    !/^[a-f0-9]{64}$/.test(metadata.digest ?? '') ||
    !/^(0|[1-9][0-9]*)$/.test(metadata.size ?? '')
  ) {
    throw new ArtifactBlobStoreError(
      'object metadata is missing or invalid',
      code,
    );
  }
  return { digest: metadata.digest!, size: BigInt(metadata.size!) };
}

function contentLength(size: bigint): number {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArtifactBlobStoreError(
      'object is too large for a single S3 upload',
      'invalid_size',
    );
  }
  return Number(size);
}

function isS3PreconditionFailed(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

async function createTemporaryFile(
  prefix: string,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `factory-floor-${prefix}-`));
  return { directory, path: join(directory, 'data') };
}

/**
 * Public S3 adapter that verifies a local spool file before publishing it with
 * an explicit content length. This keeps memory bounded, avoids SDK unknown-
 * length stream headers, and ties the digest to the exact bytes uploaded.
 */
export class S3ArtifactBlobStore extends BaseS3ArtifactBlobStore {
  override async stage(
    stagingId: StagingId,
    bytes: Readable,
    options: StageOptions = {},
  ): Promise<StagingReceipt> {
    validateStagingId(stagingId);
    if (options.expectedDigest !== undefined)
      validateDigest(options.expectedDigest);
    if (options.expectedSize !== undefined && options.expectedSize < 0n) {
      throw new ArtifactBlobStoreError(
        'expected size must be non-negative',
        'invalid_size',
      );
    }

    const store = this as unknown as S3Internals;
    const finalKey = store.stagingKey(stagingId);
    const temporary = await createTemporaryFile('s3-stage');
    const meter = createDigestMeter();
    try {
      await pipeline(
        bytes,
        meter.stream,
        createWriteStream(temporary.path, { flags: 'wx' }),
      );
      const measured = meter.result();
      if (
        options.expectedSize !== undefined &&
        options.expectedSize !== measured.size
      ) {
        throw new ArtifactBlobStoreError(
          'staged content size did not match expected size',
          'size_mismatch',
        );
      }
      if (
        options.expectedDigest !== undefined &&
        options.expectedDigest !== measured.digest
      ) {
        throw new ArtifactBlobStoreError(
          'staged content digest did not match expected digest',
          'digest_mismatch',
        );
      }

      try {
        await store.client.send(
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: finalKey,
            Body: createReadStream(temporary.path),
            ContentLength: contentLength(measured.size),
            Metadata: objectMetadata(measured),
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (!isS3PreconditionFailed(error)) throw error;
        const existing = await store.readVerifiedMetadata(
          finalKey,
          'staging_conflict',
        );
        if (
          existing.digest !== measured.digest ||
          existing.size !== measured.size
        ) {
          throw new ArtifactBlobStoreError(
            'staging object conflicts with existing content',
            'staging_conflict',
          );
        }
        return {
          stagingId,
          digest: existing.digest,
          size: existing.size,
          stagedLocator: store.locator(finalKey),
        };
      }

      return {
        stagingId,
        digest: measured.digest,
        size: measured.size,
        stagedLocator: store.locator(finalKey),
      };
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  }

  override async promote(
    stagingId: StagingId,
    digest: HexSha256Digest,
    size: bigint,
  ): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n)
      throw new ArtifactBlobStoreError(
        'size must be non-negative',
        'invalid_size',
      );

    const store = this as unknown as S3Internals;
    const stagedKey = store.stagingKey(stagingId);
    const committedKey = store.committedKey(digest);
    const committedLocator = store.locator(committedKey);

    if (await store.objectExists(committedKey)) {
      const existing = await store.readVerifiedMetadata(
        committedKey,
        'committed_conflict',
      );
      if (existing.digest !== digest || existing.size !== size) {
        throw new ArtifactBlobStoreError(
          'committed object conflicts with requested digest or size',
          'committed_conflict',
        );
      }
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }
    if (!(await store.objectExists(stagedKey))) {
      throw new ArtifactBlobStoreError(
        `staged object ${stagingId} was not found`,
        'not_found',
      );
    }

    const stagedHead = await store.headObject(stagedKey, 'staging_conflict');
    const stagedMetadata = parseMetadata(
      stagedHead.Metadata,
      'staging_conflict',
    );
    if (stagedMetadata.size !== size) {
      throw new ArtifactBlobStoreError(
        'staged metadata size does not match promotion size',
        'size_mismatch',
      );
    }
    if (stagedMetadata.digest !== digest) {
      throw new ArtifactBlobStoreError(
        'staged metadata digest does not match promotion digest',
        'digest_mismatch',
      );
    }

    const temporary = await createTemporaryFile('s3-promote');
    const meter = createDigestMeter();
    try {
      await pipeline(
        await store.getReadable(stagedKey, 'staging_conflict'),
        meter.stream,
        createWriteStream(temporary.path, { flags: 'wx' }),
      );
      const measured = meter.result();
      if (measured.size !== size) {
        throw new ArtifactBlobStoreError(
          'staged content size does not match promotion size',
          'size_mismatch',
        );
      }
      if (measured.digest !== digest) {
        throw new ArtifactBlobStoreError(
          'staged content digest does not match promotion digest',
          'digest_mismatch',
        );
      }

      try {
        await store.client.send(
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: committedKey,
            Body: createReadStream(temporary.path),
            ContentLength: contentLength(measured.size),
            Metadata: objectMetadata(measured),
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (!isS3PreconditionFailed(error)) throw error;
        const existing = await store.readVerifiedMetadata(
          committedKey,
          'committed_conflict',
        );
        if (existing.digest !== digest || existing.size !== size) {
          throw new ArtifactBlobStoreError(
            'committed object conflicts with requested digest or size',
            'committed_conflict',
          );
        }
      }

      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  }
}
