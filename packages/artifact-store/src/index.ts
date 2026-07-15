import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
    if (options.expectedSize !== undefined && options.expectedSize < 0n) throw new ArtifactBlobStoreError('expected size must be non-negative', 'invalid_size');
    await this.ensureRoots();

    const finalDirectory = this.stagedObjectDirectory(stagingId);
    const temporaryDirectory = await this.createTemporaryObjectDirectory('stage');
    const temporaryData = join(temporaryDirectory, 'data');

    const hash = createHash('sha256');
    let size = 0n;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += BigInt(chunk.length);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(bytes, meter, createWriteStream(temporaryData, { flags: 'wx' }));
      const digest = hash.digest('hex');
      if (options.expectedDigest !== undefined && options.expectedDigest !== digest) throw new ArtifactBlobStoreError('staged content digest did not match expected digest', 'digest_mismatch');
      if (options.expectedSize !== undefined && options.expectedSize !== size) throw new ArtifactBlobStoreError('staged content size did not match expected size', 'size_mismatch');
      await writeObjectMetadata(temporaryDirectory, digest, size);
      await this.publishObjectDirectory(temporaryDirectory, finalDirectory, 'staging_conflict', digest, size);
      return this.stagingReceipt(stagingId, digest, size);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (isAlreadyPublished(error, 'staging_conflict')) {
        const existing = await this.readValidObjectMetadata(finalDirectory, 'staging_conflict');
        return this.stagingReceipt(stagingId, existing.digest, existing.size);
      }
      throw error;
    }
  }

  async readStaged(stagingId: StagingId): Promise<Readable> {
    validateStagingId(stagingId);
    const directory = this.stagedObjectDirectory(stagingId);
    await this.assertValidObject(directory, 'not_found');
    return createReadStream(join(directory, 'data'));
  }

  async promote(stagingId: StagingId, digest: HexSha256Digest, size: bigint): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n) throw new ArtifactBlobStoreError('size must be non-negative', 'invalid_size');
    await this.ensureRoots();
    await this.ensureCommittedPrefix(digest);
    const committedDirectory = this.committedObjectDirectory(digest);
    const committedLocator = this.committedLocator(digest);

    if (await this.validObjectExists(committedDirectory, digest, size)) {
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }
    if (await directoryExists(committedDirectory)) throw new ArtifactBlobStoreError('committed object exists but is incomplete or conflicting', 'committed_conflict');

    const stagedDirectory = this.stagedObjectDirectory(stagingId);
    if (!(await this.validObjectExists(stagedDirectory, digest, size))) {
      if (await this.validObjectExists(committedDirectory, digest, size)) return { digest, size, committedLocator };
      if (await directoryExists(stagedDirectory)) throw new ArtifactBlobStoreError('staged object exists but is incomplete or conflicting', 'staging_conflict');
      throw new ArtifactBlobStoreError(`staged object ${stagingId} was not found`, 'not_found');
    }

    const temporaryDirectory = await this.createTemporaryObjectDirectory('commit');
    try {
      await pipeline(createReadStream(join(stagedDirectory, 'data')), createWriteStream(join(temporaryDirectory, 'data'), { flags: 'wx' }));
      await writeObjectMetadata(temporaryDirectory, digest, size);
      await this.publishObjectDirectory(temporaryDirectory, committedDirectory, 'committed_conflict', digest, size);
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
    await this.assertValidObject(directory, 'not_found');
    return createReadStream(join(directory, 'data'));
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
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000');
    await this.ensureRootDirectory(this.root);
    await this.ensureRootDirectory(this.stagingRoot);
    const entries = await readdirSafe(this.stagingRoot);
    const ids = entries.filter((entry) => isValidStagingId(entry)).sort();
    const cursor = options.cursor;
    const start = cursor === undefined ? 0 : ids.findIndex((id) => id > cursor);
    const slice = ids.slice(start < 0 ? ids.length : start, (start < 0 ? ids.length : start) + options.limit);
    const objects: StagedObject[] = [];
    for (const id of slice) {
      const metadata = await this.readValidObjectMetadata(this.stagedObjectDirectory(id), 'not_found');
      objects.push(this.stagingReceipt(id, metadata.digest, metadata.size));
    }
    const last = slice.at(-1);
    const nextCursor = last !== undefined && ids.some((id) => id > last) ? last : undefined;
    return { objects, nextCursor };
  }

  private async publishObjectDirectory(temporaryDirectory: string, finalDirectory: string, conflictCode: 'staging_conflict' | 'committed_conflict', digest: string, size: bigint): Promise<void> {
    await this.assertValidObject(temporaryDirectory, conflictCode);
    try {
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      const existing = await this.readValidObjectMetadata(finalDirectory, conflictCode);
      if (existing.digest !== digest || existing.size !== size) throw new ArtifactBlobStoreError('object identity conflicts with existing content', conflictCode);
      throw new AlreadyPublishedError(conflictCode);
    }
  }

  private async validObjectExists(directory: string, expectedDigest?: string, expectedSize?: bigint): Promise<boolean> {
    try {
      const metadata = await this.readValidObjectMetadata(directory, 'not_found');
      if (expectedDigest !== undefined && metadata.digest !== expectedDigest) return false;
      if (expectedSize !== undefined && metadata.size !== expectedSize) return false;
      return true;
    } catch (error) {
      if (error instanceof ArtifactBlobStoreError && error.code === 'not_found') return false;
      throw error;
    }
  }

  private async assertValidObject(directory: string, missingCode: ArtifactBlobStoreError['code']): Promise<void> {
    await assertDirectoryNoFollow(directory, missingCode);
    await assertRegularNoFollow(join(directory, 'data'), missingCode);
    await readMetadata(join(directory, 'metadata.json'), missingCode);
  }

  private async readValidObjectMetadata(directory: string, missingCode: ArtifactBlobStoreError['code']): Promise<ObjectMetadata> {
    await this.assertValidObject(directory, missingCode);
    return readMetadata(join(directory, 'metadata.json'), missingCode);
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
    if (!isWithin(actualRoot, actualDirectory)) throw new ArtifactBlobStoreError('storage directory escapes configured root', 'unsafe_path');
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

class AlreadyPublishedError extends Error {
  constructor(readonly conflictCode: 'staging_conflict' | 'committed_conflict') {
    super('object was already published');
  }
}

function isAlreadyPublished(error: unknown, conflictCode: 'staging_conflict' | 'committed_conflict'): error is AlreadyPublishedError {
  return error instanceof AlreadyPublishedError && error.conflictCode === conflictCode;
}

export function validateStagingId(stagingId: string): void {
  if (!isValidStagingId(stagingId)) throw new ArtifactBlobStoreError('invalid staging id', 'invalid_staging_id');
}

function isValidStagingId(stagingId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stagingId) && !stagingId.includes('..');
}

export function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new ArtifactBlobStoreError('invalid SHA-256 digest', 'invalid_digest');
}

function safeJoin(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  if (!isWithin(root, path)) throw new ArtifactBlobStoreError('resolved path escaped storage root', 'unsafe_path');
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
    if (!stats.isDirectory()) throw new ArtifactBlobStoreError('expected directory without symlink', missingCode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactBlobStoreError('directory not found', missingCode);
    throw error;
  }
}

async function assertRegularNoFollow(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) throw new ArtifactBlobStoreError('expected regular file without symlink', missingCode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactBlobStoreError('file not found', missingCode);
    throw error;
  }
}

async function writeObjectMetadata(directory: string, digest: string, size: bigint): Promise<void> {
  await writeFile(join(directory, 'metadata.json'), JSON.stringify({ digest, size: size.toString() }) + '\n', { flag: 'wx' });
  await readMetadata(join(directory, 'metadata.json'), 'not_found');
}

async function readMetadata(path: string, missingCode: ArtifactBlobStoreError['code']): Promise<ObjectMetadata> {
  try {
    await assertRegularNoFollow(path, missingCode);
    const data = JSON.parse(await readFile(path, 'utf8')) as SidecarMetadata;
    validateDigest(data.digest);
    if (!/^(0|[1-9][0-9]*)$/.test(data.size)) throw new ArtifactBlobStoreError('invalid metadata size', missingCode);
    return { digest: data.digest, size: BigInt(data.size) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactBlobStoreError('object metadata not found', missingCode);
    throw error;
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
