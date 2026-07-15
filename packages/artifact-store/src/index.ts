import { constants, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

export type HexSha256Digest = string;
export type StagingId = string;

export interface StageOptions {
  readonly expectedDigest?: HexSha256Digest;
  readonly expectedSize?: bigint;
}

export interface StagingReceipt {
  readonly stagingId: StagingId;
  readonly digest: HexSha256Digest;
  readonly size: bigint;
  readonly stagedLocator: string;
}

export interface CommittedReceipt {
  readonly digest: HexSha256Digest;
  readonly size: bigint;
  readonly committedLocator: string;
}

export interface StagedObject {
  readonly stagingId: StagingId;
  readonly digest: HexSha256Digest;
  readonly size: bigint;
  readonly stagedLocator: string;
}

export interface StagedObjectPage {
  readonly objects: StagedObject[];
  readonly nextCursor?: string;
}

export interface ListStagedOptions {
  readonly limit: number;
  readonly cursor?: string;
}

export interface ArtifactBlobStore {
  stage(stagingId: StagingId, bytes: Readable, options?: StageOptions): Promise<StagingReceipt>;
  readStaged(stagingId: StagingId): Promise<Readable>;
  promote(stagingId: StagingId, digest: HexSha256Digest, size: bigint): Promise<CommittedReceipt>;
  readCommitted(digest: HexSha256Digest): Promise<Readable>;
  removeStaged(stagingId: StagingId): Promise<void>;
  stagedExists(stagingId: StagingId): Promise<boolean>;
  committedExists(digest: HexSha256Digest): Promise<boolean>;
  listStaged(options: ListStagedOptions): Promise<StagedObjectPage>;
}

export class ArtifactBlobStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_staging_id'
      | 'invalid_digest'
      | 'invalid_size'
      | 'not_found'
      | 'digest_mismatch'
      | 'size_mismatch'
      | 'staging_conflict'
      | 'committed_conflict'
      | 'unsafe_path',
  ) {
    super(message);
    this.name = 'ArtifactBlobStoreError';
  }
}

interface SidecarMetadata {
  readonly digest: string;
  readonly size: string;
}

interface ObjectMetadata {
  readonly digest: string;
  readonly size: bigint;
}

const metadataFormat = 'factory-floor-artifact-blob';
const metadataVersion = '1';

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

export class FilesystemArtifactBlobStore implements ArtifactBlobStore {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly committedRoot: string;
  private readonly temporaryRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.stagingRoot = join(this.root, 'staging');
    this.committedRoot = join(this.root, 'committed');
    this.temporaryRoot = join(this.root, 'tmp');
  }

  async stage(stagingId: StagingId, bytes: Readable, options: StageOptions = {}): Promise<StagingReceipt> {
    validateStagingId(stagingId);
    if (options.expectedDigest !== undefined) validateDigest(options.expectedDigest);
    if (options.expectedSize !== undefined && options.expectedSize < 0n) {
      throw new ArtifactBlobStoreError('expected size must be non-negative', 'invalid_size');
    }
    await this.ensureRoots();

    const finalDirectory = this.stagedObjectDirectory(stagingId);
    const temporaryDirectory = await this.createTemporaryObjectDirectory('stage');
    const temporaryData = join(temporaryDirectory, 'data');
    const meter = createDigestMeter();

    try {
      await pipeline(bytes, meter.stream, createWriteStream(temporaryData, { flags: 'wx' }));
      const measured = meter.result();
      if (options.expectedSize !== undefined && options.expectedSize !== measured.size) {
        throw new ArtifactBlobStoreError('staged content size did not match expected size', 'size_mismatch');
      }
      if (options.expectedDigest !== undefined && options.expectedDigest !== measured.digest) {
        throw new ArtifactBlobStoreError('staged content digest did not match expected digest', 'digest_mismatch');
      }
      await writeObjectMetadata(temporaryDirectory, measured.digest, measured.size);
      await this.publishObjectDirectory(
        temporaryDirectory,
        finalDirectory,
        'staging_conflict',
        measured.digest,
        measured.size,
      );
      return this.stagingReceipt(stagingId, measured.digest, measured.size);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (isAlreadyPublished(error, 'staging_conflict')) {
        const existing = await this.readVerifiedObjectMetadata(finalDirectory, 'staging_conflict');
        return this.stagingReceipt(stagingId, existing.digest, existing.size);
      }
      throw error;
    }
  }

  async readStaged(stagingId: StagingId): Promise<Readable> {
    validateStagingId(stagingId);
    const directory = this.stagedObjectDirectory(stagingId);
    await this.readVerifiedObjectMetadata(directory, 'not_found');
    return openReadableNoFollow(join(directory, 'data'), 'not_found');
  }

  async promote(stagingId: StagingId, digest: HexSha256Digest, size: bigint): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n) throw new ArtifactBlobStoreError('size must be non-negative', 'invalid_size');
    await this.ensureRoots();
    await this.ensureCommittedPrefix(digest);

    const committedDirectory = this.committedObjectDirectory(digest);
    const committedLocator = this.committedLocator(digest);
    if (await directoryExists(committedDirectory)) {
      const existing = await this.readVerifiedObjectMetadata(committedDirectory, 'committed_conflict');
      if (existing.size !== size || existing.digest !== digest) {
        throw new ArtifactBlobStoreError('committed object conflicts with requested digest or size', 'committed_conflict');
      }
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }

    const stagedDirectory = this.stagedObjectDirectory(stagingId);
    if (!(await directoryExists(stagedDirectory))) {
      throw new ArtifactBlobStoreError(`staged object ${stagingId} was not found`, 'not_found');
    }

    const stagedMetadata = await this.readObjectMetadata(stagedDirectory, 'staging_conflict');
    if (stagedMetadata.size !== size) {
      throw new ArtifactBlobStoreError('staged metadata size does not match promotion size', 'size_mismatch');
    }
    if (stagedMetadata.digest !== digest) {
      throw new ArtifactBlobStoreError('staged metadata digest does not match promotion digest', 'digest_mismatch');
    }

    const temporaryDirectory = await this.createTemporaryObjectDirectory('commit');
    try {
      const measured = await copyAndMeasureNoFollow(
        join(stagedDirectory, 'data'),
        join(temporaryDirectory, 'data'),
        'staging_conflict',
      );
      if (measured.size !== size) {
        throw new ArtifactBlobStoreError('staged content size does not match promotion size', 'size_mismatch');
      }
      if (measured.digest !== digest) {
        throw new ArtifactBlobStoreError('staged content digest does not match promotion digest', 'digest_mismatch');
      }
      await writeObjectMetadata(temporaryDirectory, measured.digest, measured.size);
      await this.publishObjectDirectory(
        temporaryDirectory,
        committedDirectory,
        'committed_conflict',
        measured.digest,
        measured.size,
      );
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (isAlreadyPublished(error, 'committed_conflict')) {
        await this.removeStaged(stagingId);
        return { digest, size, committedLocator };
      }
      throw error;
    }
  }

  async readCommitted(digest: HexSha256Digest): Promise<Readable> {
    validateDigest(digest);
    const directory = this.committedObjectDirectory(digest);
    await this.readVerifiedObjectMetadata(directory, 'not_found');
    return openReadableNoFollow(join(directory, 'data'), 'not_found');
  }

  async removeStaged(stagingId: StagingId): Promise<void> {
    validateStagingId(stagingId);
    await rm(this.stagedObjectDirectory(stagingId), { recursive: true, force: true });
  }

  async stagedExists(stagingId: StagingId): Promise<boolean> {
    validateStagingId(stagingId);
    return this.validObjectExists(this.stagedObjectDirectory(stagingId));
  }

  async committedExists(digest: HexSha256Digest): Promise<boolean> {
    validateDigest(digest);
    return this.validObjectExists(this.committedObjectDirectory(digest));
  }

  async listStaged(options: ListStagedOptions): Promise<StagedObjectPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw new RangeError('limit must be an integer from 1 to 1000');
    }
    await this.ensureRootDirectory(this.root);
    await this.ensureRootDirectory(this.stagingRoot);
    const entries = await readdirSafe(this.stagingRoot);
    const ids = entries.filter((entry) => isValidStagingId(entry)).sort();
    const cursor = options.cursor;
    const start = cursor === undefined ? 0 : ids.findIndex((id) => id > cursor);
    const slice = ids.slice(start < 0 ? ids.length : start, (start < 0 ? ids.length : start) + options.limit);
    const objects: StagedObject[] = [];
    for (const id of slice) {
      const metadata = await this.readVerifiedObjectMetadata(this.stagedObjectDirectory(id), 'not_found');
      objects.push(this.stagingReceipt(id, metadata.digest, metadata.size));
    }
    const last = slice.at(-1);
    const nextCursor = last !== undefined && ids.some((id) => id > last) ? last : undefined;
    return { objects, nextCursor };
  }

  private async publishObjectDirectory(
    temporaryDirectory: string,
    finalDirectory: string,
    conflictCode: 'staging_conflict' | 'committed_conflict',
    digest: string,
    size: bigint,
  ): Promise<void> {
    const temporary = await this.readVerifiedObjectMetadata(temporaryDirectory, conflictCode);
    if (temporary.digest !== digest || temporary.size !== size) {
      throw new ArtifactBlobStoreError('temporary object identity does not match requested content', conflictCode);
    }
    try {
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      const existing = await this.readVerifiedObjectMetadata(finalDirectory, conflictCode);
      if (existing.digest !== digest || existing.size !== size) {
        throw new ArtifactBlobStoreError('object identity conflicts with existing content', conflictCode);
      }
      throw new AlreadyPublishedError(conflictCode);
    }
  }

  private async validObjectExists(directory: string, expectedDigest?: string, expectedSize?: bigint): Promise<boolean> {
    try {
      const metadata = await this.readVerifiedObjectMetadata(directory, 'not_found');
      if (expectedDigest !== undefined && metadata.digest !== expectedDigest) return false;
      if (expectedSize !== undefined && metadata.size !== expectedSize) return false;
      return true;
    } catch (error) {
      if (error instanceof ArtifactBlobStoreError && error.code === 'not_found') return false;
      throw error;
    }
  }

  private async readObjectMetadata(
    directory: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<ObjectMetadata> {
    await assertDirectoryNoFollow(directory, missingCode);
    await assertRegularNoFollow(join(directory, 'data'), missingCode);
    return readMetadata(join(directory, 'metadata.json'), missingCode);
  }

  private async readVerifiedObjectMetadata(
    directory: string,
    missingCode: ArtifactBlobStoreError['code'],
  ): Promise<ObjectMetadata> {
    const metadata = await this.readObjectMetadata(directory, missingCode);
    const measured = await measureFileNoFollow(join(directory, 'data'), missingCode);
    if (measured.size !== metadata.size || measured.digest !== metadata.digest) {
      throw new ArtifactBlobStoreError('object content does not match its metadata', missingCode);
    }
    return metadata;
  }

  private async ensureRoots(): Promise<void> {
    await this.ensureRootDirectory(this.root);
    await this.ensureRootDirectory(this.stagingRoot);
    await this.ensureRootDirectory(this.committedRoot);
    await this.ensureRootDirectory(this.temporaryRoot);
  }

  private async ensureCommittedPrefix(digest: string): Promise<void> {
    await this.ensureRootDirectory(join(this.committedRoot, 'sha256'));
    await this.ensureRootDirectory(join(this.committedRoot, 'sha256', digest.slice(0, 2)));
  }

  private async ensureRootDirectory(directory: string): Promise<void> {
    const relative = resolve(directory).slice(this.root.length).replace(/^\/+/, '');
    const path = safeJoin(this.root, relative);
    await mkdir(path, { recursive: true });
    await assertDirectoryNoFollow(path, 'unsafe_path');
    const actualRoot = await realpath(this.root);
    const actualDirectory = await realpath(path);
    if (!isWithin(actualRoot, actualDirectory)) {
      throw new ArtifactBlobStoreError('storage directory escapes configured root', 'unsafe_path');
    }
  }

  private async createTemporaryObjectDirectory(kind: string): Promise<string> {
    const directory = safeJoin(this.temporaryRoot, `${kind}-${randomUUID()}`);
    await mkdir(directory, { recursive: false });
    return directory;
  }

  private stagingReceipt(stagingId: string, digest: string, size: bigint): StagingReceipt {
    return { stagingId, digest, size, stagedLocator: `file:staging/${stagingId}` };
  }

  private committedLocator(digest: string): string {
    return `file:committed/sha256/${digest.slice(0, 2)}/${digest}`;
  }

  private stagedObjectDirectory(id: string): string {
    return safeJoin(this.stagingRoot, id);
  }

  private committedObjectDirectory(digest: string): string {
    return safeJoin(this.committedRoot, 'sha256', digest.slice(0, 2), digest);
  }
}

export interface S3ArtifactBlobStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix?: string;
  readonly forcePathStyle?: boolean;
  readonly clientConfig?: Omit<S3ClientConfig, 'endpoint' | 'region' | 'forcePathStyle'>;
}

export class S3ArtifactBlobStore implements ArtifactBlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3ArtifactBlobStoreConfig) {
    this.bucket = config.bucket;
    this.prefix = normalizeS3Prefix(config.prefix ?? '');
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...config.clientConfig,
    });
  }

  async stage(stagingId: StagingId, bytes: Readable, options: StageOptions = {}): Promise<StagingReceipt> {
    validateStagingId(stagingId);
    if (options.expectedDigest !== undefined) validateDigest(options.expectedDigest);
    if (options.expectedSize !== undefined && options.expectedSize < 0n) {
      throw new ArtifactBlobStoreError('expected size must be non-negative', 'invalid_size');
    }

    const tmpKey = this.tmpKey(`stage-${randomUUID()}`);
    const finalKey = this.stagingKey(stagingId);
    const meter = createDigestMeter();
    let measured: ObjectMetadata | undefined;
    try {
      const upload = this.putObject(tmpKey, meter.stream, undefined);
      await pipeline(bytes, meter.stream);
      await upload;
      measured = meter.result();
      if (options.expectedSize !== undefined && options.expectedSize !== measured.size) {
        throw new ArtifactBlobStoreError('staged content size did not match expected size', 'size_mismatch');
      }
      if (options.expectedDigest !== undefined && options.expectedDigest !== measured.digest) {
        throw new ArtifactBlobStoreError('staged content digest did not match expected digest', 'digest_mismatch');
      }
      await this.putObject(finalKey, await this.getReadable(tmpKey, 'staging_conflict'), measured, true);
      return this.stagingReceipt(stagingId, measured.digest, measured.size);
    } catch (error) {
      if (isS3PreconditionFailed(error)) {
        const existing = await this.readVerifiedMetadata(finalKey, 'staging_conflict');
        if (measured !== undefined && existing.digest === measured.digest && existing.size === measured.size) {
          return this.stagingReceipt(stagingId, existing.digest, existing.size);
        }
        throw new ArtifactBlobStoreError('staging object conflicts with existing content', 'staging_conflict');
      }
      throw error;
    } finally {
      await this.deleteObject(tmpKey);
    }
  }

  async readStaged(stagingId: StagingId): Promise<Readable> {
    validateStagingId(stagingId);
    const key = this.stagingKey(stagingId);
    await this.readVerifiedMetadata(key, 'not_found');
    return this.getReadable(key, 'not_found');
  }

  async promote(stagingId: StagingId, digest: HexSha256Digest, size: bigint): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n) throw new ArtifactBlobStoreError('size must be non-negative', 'invalid_size');
    const stagedKey = this.stagingKey(stagingId);
    const committedKey = this.committedKey(digest);
    const committedLocator = this.locator(committedKey);

    if (await this.validObjectExists(committedKey, digest, size, 'committed_conflict')) {
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }
    if (!(await this.objectExists(stagedKey))) {
      throw new ArtifactBlobStoreError(`staged object ${stagingId} was not found`, 'not_found');
    }
    const staged = await this.readVerifiedMetadata(stagedKey, 'staging_conflict');
    if (staged.size !== size) throw new ArtifactBlobStoreError('staged content size does not match promotion size', 'size_mismatch');
    if (staged.digest !== digest) throw new ArtifactBlobStoreError('staged content digest does not match promotion digest', 'digest_mismatch');

    try {
      await this.putObject(committedKey, await this.getReadable(stagedKey, 'staging_conflict'), { digest, size }, true);
    } catch (error) {
      if (!isS3PreconditionFailed(error)) throw error;
      if (!(await this.validObjectExists(committedKey, digest, size, 'committed_conflict'))) {
        throw new ArtifactBlobStoreError('committed object conflicts with requested digest or size', 'committed_conflict');
      }
    }
    await this.removeStaged(stagingId);
    return { digest, size, committedLocator };
  }

  async readCommitted(digest: HexSha256Digest): Promise<Readable> {
    validateDigest(digest);
    const key = this.committedKey(digest);
    await this.readVerifiedMetadata(key, 'not_found');
    return this.getReadable(key, 'not_found');
  }

  async removeStaged(stagingId: StagingId): Promise<void> {
    validateStagingId(stagingId);
    await this.deleteObject(this.stagingKey(stagingId));
  }

  async stagedExists(stagingId: StagingId): Promise<boolean> {
    validateStagingId(stagingId);
    return this.validObjectExists(this.stagingKey(stagingId), undefined, undefined, 'not_found');
  }

  async committedExists(digest: HexSha256Digest): Promise<boolean> {
    validateDigest(digest);
    return this.validObjectExists(this.committedKey(digest), digest, undefined, 'not_found');
  }

  async listStaged(options: ListStagedOptions): Promise<StagedObjectPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw new RangeError('limit must be an integer from 1 to 1000');
    }
    const prefix = this.key('staging/');
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      ContinuationToken: options.cursor,
      MaxKeys: options.limit,
    }));
    const objects: StagedObject[] = [];
    for (const item of response.Contents ?? []) {
      if (item.Key === undefined || item.Key.endsWith('/')) continue;
      const stagingId = item.Key.slice(prefix.length);
      if (!isValidStagingId(stagingId)) continue;
      const metadata = await this.readVerifiedMetadata(item.Key, 'not_found');
      objects.push(this.stagingReceipt(stagingId, metadata.digest, metadata.size));
    }
    return { objects, nextCursor: response.NextContinuationToken };
  }

  private async putObject(
    key: string,
    body: Readable,
    metadata: ObjectMetadata | undefined,
    ifNoneMatch = false,
  ): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      Metadata: metadata === undefined ? undefined : s3Metadata(metadata),
      ...(ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }));
  }

  private async readVerifiedMetadata(key: string, missingCode: ArtifactBlobStoreError['code']): Promise<ObjectMetadata> {
    const head = await this.headObject(key, missingCode);
    const metadata = parseS3Metadata(head.Metadata ?? {}, missingCode);
    const measured = await this.measureObject(key, missingCode);
    if (measured.digest !== metadata.digest || measured.size !== metadata.size) {
      throw new ArtifactBlobStoreError('object content does not match its metadata', missingCode);
    }
    return metadata;
  }

  private async measureObject(key: string, missingCode: ArtifactBlobStoreError['code']): Promise<ObjectMetadata> {
    const source = await this.getReadable(key, missingCode);
    const accumulator = new DigestAccumulator();
    for await (const chunk of source) accumulator.update(chunk);
    return accumulator.result();
  }

  private async getReadable(key: string, missingCode: ArtifactBlobStoreError['code']): Promise<Readable> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (response.Body === undefined || !('pipe' in response.Body)) {
        throw new ArtifactBlobStoreError('object body is not readable', missingCode);
      }
      return response.Body as Readable;
    } catch (error) {
      if (isS3NotFound(error)) throw new ArtifactBlobStoreError('object not found', missingCode);
      throw error;
    }
  }

  private async headObject(key: string, missingCode: ArtifactBlobStoreError['code']) {
    try {
      return await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isS3NotFound(error)) throw new ArtifactBlobStoreError('object not found', missingCode);
      throw error;
    }
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.headObject(key, 'not_found');
      return true;
    } catch (error) {
      if (error instanceof ArtifactBlobStoreError && error.code === 'not_found') return false;
      throw error;
    }
  }

  private async validObjectExists(
    key: string,
    expectedDigest: string | undefined,
    expectedSize: bigint | undefined,
    conflictCode: ArtifactBlobStoreError['code'],
  ): Promise<boolean> {
    try {
      const metadata = await this.readVerifiedMetadata(key, conflictCode);
      if (expectedDigest !== undefined && metadata.digest !== expectedDigest) return false;
      if (expectedSize !== undefined && metadata.size !== expectedSize) return false;
      return true;
    } catch (error) {
      if (error instanceof ArtifactBlobStoreError && error.code === 'not_found') return false;
      if (conflictCode === 'not_found' && error instanceof ArtifactBlobStoreError && error.code === 'not_found') return false;
      throw error;
    }
  }

  private async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private stagingReceipt(stagingId: string, digest: string, size: bigint): StagingReceipt {
    return { stagingId, digest, size, stagedLocator: this.locator(this.stagingKey(stagingId)) };
  }

  private stagingKey(stagingId: string): string {
    return this.key(`staging/${stagingId}`);
  }

  private committedKey(digest: string): string {
    return this.key(`committed/sha256/${digest.slice(0, 2)}/${digest}`);
  }

  private tmpKey(operationId: string): string {
    return this.key(`tmp/${operationId}`);
  }

  private key(path: string): string {
    return `${this.prefix}${path}`;
  }

  private locator(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }
}

class AlreadyPublishedError extends Error {
  constructor(readonly conflictCode: 'staging_conflict' | 'committed_conflict') {
    super('object was already published');
  }
}

function isAlreadyPublished(
  error: unknown,
  conflictCode: 'staging_conflict' | 'committed_conflict',
): error is AlreadyPublishedError {
  return error instanceof AlreadyPublishedError && error.conflictCode === conflictCode;
}

export function validateStagingId(stagingId: string): void {
  if (!isValidStagingId(stagingId)) {
    throw new ArtifactBlobStoreError('invalid staging id', 'invalid_staging_id');
  }
}

function isValidStagingId(stagingId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stagingId) && !stagingId.includes('..');
}

export function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ArtifactBlobStoreError('invalid SHA-256 digest', 'invalid_digest');
  }
}

function safeJoin(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  if (!isWithin(root, path)) {
    throw new ArtifactBlobStoreError('resolved path escaped storage root', 'unsafe_path');
  }
  return path;
}

function isWithin(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertDirectoryNoFollow(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      throw new ArtifactBlobStoreError('expected directory without symlink', missingCode);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ArtifactBlobStoreError('directory not found', missingCode);
    }
    throw error;
  }
}

async function assertRegularNoFollow(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new ArtifactBlobStoreError('expected regular file without symlink', missingCode);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ArtifactBlobStoreError('file not found', missingCode);
    }
    throw error;
  }
}

async function openReadableNoFollow(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<Readable> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return handle.createReadStream({ autoClose: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      throw new ArtifactBlobStoreError('file could not be opened safely', missingCode);
    }
    throw error;
  }
}

async function copyAndMeasureNoFollow(
  sourcePath: string,
  targetPath: string,
  missingCode: ArtifactBlobStoreError['code'],
): Promise<ObjectMetadata> {
  const source = await openReadableNoFollow(sourcePath, missingCode);
  const meter = createDigestMeter();
  await pipeline(source, meter.stream, createWriteStream(targetPath, { flags: 'wx' }));
  return meter.result();
}

async function measureFileNoFollow(
  path: string,
  missingCode: ArtifactBlobStoreError['code'],
): Promise<ObjectMetadata> {
  const source = await openReadableNoFollow(path, missingCode);
  const accumulator = new DigestAccumulator();
  for await (const chunk of source) accumulator.update(chunk);
  return accumulator.result();
}

async function writeObjectMetadata(directory: string, digest: string, size: bigint): Promise<void> {
  await writeFile(
    join(directory, 'metadata.json'),
    JSON.stringify({ digest, size: size.toString() }) + '\n',
    { flag: 'wx' },
  );
  await readMetadata(join(directory, 'metadata.json'), 'not_found');
}

async function readMetadata(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<ObjectMetadata> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const data = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as SidecarMetadata;
    validateDigest(data.digest);
    if (!/^(0|[1-9][0-9]*)$/.test(data.size)) {
      throw new ArtifactBlobStoreError('invalid metadata size', missingCode);
    }
    return { digest: data.digest, size: BigInt(data.size) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      throw new ArtifactBlobStoreError('object metadata not found or unsafe', missingCode);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function s3Metadata(metadata: ObjectMetadata): Record<string, string> {
  return {
    digest: metadata.digest,
    size: metadata.size.toString(),
    format: metadataFormat,
    version: metadataVersion,
  };
}

function parseS3Metadata(
  metadata: Record<string, string>,
  missingCode: ArtifactBlobStoreError['code'],
): ObjectMetadata {
  if (metadata.format !== metadataFormat || metadata.version !== metadataVersion) {
    throw new ArtifactBlobStoreError('object metadata format is missing or unsupported', missingCode);
  }
  validateDigest(metadata.digest ?? '');
  const size = metadata.size;
  if (size === undefined || !/^(0|[1-9][0-9]*)$/.test(size)) {
    throw new ArtifactBlobStoreError('invalid metadata size', missingCode);
  }
  return { digest: metadata.digest, size: BigInt(size) };
}

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ArtifactBlobStoreError('invalid S3 key prefix', 'unsafe_path');
  }
  return `${trimmed}/`;
}

function isS3NotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error instanceof NoSuchKey || candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

function isS3PreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}
