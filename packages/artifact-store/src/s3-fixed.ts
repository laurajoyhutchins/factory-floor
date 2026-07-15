import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ArtifactBlobStoreError,
  S3ArtifactBlobStore as BaseS3ArtifactBlobStore,
  validateDigest,
  validateStagingId,
  type CommittedReceipt,
  type HexSha256Digest,
  type StagingId,
} from './index.js';

interface ObjectMetadata {
  readonly digest: string;
  readonly size: bigint;
}

interface S3Internals {
  stagingKey(stagingId: string): string;
  committedKey(digest: string): string;
  tmpKey(operationId: string): string;
  locator(key: string): string;
  objectExists(key: string): Promise<boolean>;
  validObjectExists(
    key: string,
    expectedDigest: string | undefined,
    expectedSize: bigint | undefined,
    conflictCode: ArtifactBlobStoreError['code'],
  ): Promise<boolean>;
  headObject(
    key: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<{ Metadata?: Record<string, string> }>;
  getReadable(key: string, missingCode: ArtifactBlobStoreError['code']): Promise<Readable>;
  putObject(key: string, body: Readable, metadata: ObjectMetadata | undefined, ifNoneMatch?: boolean): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

class DigestAccumulator {
  private readonly hash = createHash('sha256');
  private size = 0n;

  update(chunk: unknown): Buffer {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    this.hash.update(bytes);
    this.size += BigInt(bytes.length);
    return bytes;
  }

  result(): ObjectMetadata {
    return { digest: this.hash.digest('hex'), size: this.size };
  }
}

function createDigestMeter(): { readonly stream: Transform; readonly result: () => ObjectMetadata } {
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

function parseMetadata(
  metadata: Record<string, string> | undefined,
  code: ArtifactBlobStoreError['code'],
): ObjectMetadata {
  if (
    metadata?.format !== 'factory-floor-artifact-blob'
    || metadata.version !== '1'
    || !/^[a-f0-9]{64}$/.test(metadata.digest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(metadata.size ?? '')
  ) {
    throw new ArtifactBlobStoreError('object metadata is missing or invalid', code);
  }
  return { digest: metadata.digest!, size: BigInt(metadata.size!) };
}

function isS3PreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

/**
 * Public S3 adapter with promotion verification tied to the exact byte stream
 * that is conditionally published. The base implementation remains available
 * internally while the storage package is split into dedicated adapter modules.
 */
export class S3ArtifactBlobStore extends BaseS3ArtifactBlobStore {
  override async promote(
    stagingId: StagingId,
    digest: HexSha256Digest,
    size: bigint,
  ): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n) throw new ArtifactBlobStoreError('size must be non-negative', 'invalid_size');

    const store = this as unknown as S3Internals;
    const stagedKey = store.stagingKey(stagingId);
    const committedKey = store.committedKey(digest);
    const committedLocator = store.locator(committedKey);

    if (await store.validObjectExists(committedKey, digest, size, 'committed_conflict')) {
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }
    if (!(await store.objectExists(stagedKey))) {
      throw new ArtifactBlobStoreError(`staged object ${stagingId} was not found`, 'not_found');
    }

    const stagedHead = await store.headObject(stagedKey, 'staging_conflict');
    const stagedMetadata = parseMetadata(stagedHead.Metadata, 'staging_conflict');
    if (stagedMetadata.size !== size) {
      throw new ArtifactBlobStoreError('staged metadata size does not match promotion size', 'size_mismatch');
    }
    if (stagedMetadata.digest !== digest) {
      throw new ArtifactBlobStoreError('staged metadata digest does not match promotion digest', 'digest_mismatch');
    }

    const temporaryKey = store.tmpKey(`promote-${randomUUID()}`);
    const meter = createDigestMeter();
    try {
      const upload = store.putObject(temporaryKey, meter.stream, undefined);
      await pipeline(await store.getReadable(stagedKey, 'staging_conflict'), meter.stream);
      await upload;
      const measured = meter.result();
      if (measured.size !== size) {
        throw new ArtifactBlobStoreError('staged content size does not match promotion size', 'size_mismatch');
      }
      if (measured.digest !== digest) {
        throw new ArtifactBlobStoreError('staged content digest does not match promotion digest', 'digest_mismatch');
      }

      try {
        await store.putObject(
          committedKey,
          await store.getReadable(temporaryKey, 'staging_conflict'),
          measured,
          true,
        );
      } catch (error) {
        if (!isS3PreconditionFailed(error)) throw error;
        if (!(await store.validObjectExists(committedKey, digest, size, 'committed_conflict'))) {
          throw new ArtifactBlobStoreError(
            'committed object conflicts with requested digest or size',
            'committed_conflict',
          );
        }
      }

      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    } finally {
      await store.deleteObject(temporaryKey);
    }
  }
}
