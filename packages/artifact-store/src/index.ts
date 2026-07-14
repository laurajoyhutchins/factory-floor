import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

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
      | 'committed_conflict',
  ) {
    super(message);
    this.name = 'ArtifactBlobStoreError';
  }
}

interface SidecarMetadata {
  readonly digest: string;
  readonly size: string;
}

export class FilesystemArtifactBlobStore implements ArtifactBlobStore {
  private readonly stagingRoot: string;
  private readonly committedRoot: string;
  private readonly temporaryRoot: string;

  constructor(private readonly root: string) {
    const resolved = resolve(root);
    this.root = resolved;
    this.stagingRoot = join(resolved, 'staging');
    this.committedRoot = join(resolved, 'committed');
    this.temporaryRoot = join(resolved, 'tmp');
  }

  async stage(stagingId: StagingId, bytes: Readable, options: StageOptions = {}): Promise<StagingReceipt> {
    validateStagingId(stagingId);
    if (options.expectedDigest !== undefined) validateDigest(options.expectedDigest);
    if (options.expectedSize !== undefined && options.expectedSize < 0n) throw new ArtifactBlobStoreError('expected size must be non-negative', 'invalid_size');
    await this.ensureRoots();
    const target = this.stagedDataPath(stagingId);
    const metadataPath = this.stagedMetadataPath(stagingId);
    const temporaryPath = join(this.temporaryRoot, `${stagingId}.${randomUUID()}.tmp`);
    await mkdir(dirname(target), { recursive: true });

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
      await pipeline(bytes, meter, createWriteStream(temporaryPath, { flags: 'wx' }));
      const digest = hash.digest('hex');
      if (options.expectedDigest !== undefined && options.expectedDigest !== digest) {
        throw new ArtifactBlobStoreError('staged content digest did not match expected digest', 'digest_mismatch');
      }
      if (options.expectedSize !== undefined && options.expectedSize !== size) {
        throw new ArtifactBlobStoreError('staged content size did not match expected size', 'size_mismatch');
      }

      if (await exists(target)) {
        const existing = await this.readStagedMetadata(stagingId);
        if (existing.digest === digest && existing.size === size) {
          await rm(temporaryPath, { force: true });
          return this.stagingReceipt(stagingId, existing.digest, existing.size);
        }
        throw new ArtifactBlobStoreError(`staging id ${stagingId} already contains different content`, 'staging_conflict');
      }

      await link(temporaryPath, target);
      await rm(temporaryPath, { force: true });
      await writeFile(metadataPath, JSON.stringify({ digest, size: size.toString() satisfies string }) + '\n', { flag: 'wx' });
      return this.stagingReceipt(stagingId, digest, size);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (error instanceof ArtifactBlobStoreError) throw error;
      throw error;
    }
  }

  async readStaged(stagingId: StagingId): Promise<Readable> {
    validateStagingId(stagingId);
    const path = this.stagedDataPath(stagingId);
    await assertRegularExisting(path);
    return createReadStream(path);
  }

  async promote(stagingId: StagingId, digest: HexSha256Digest, size: bigint): Promise<CommittedReceipt> {
    validateStagingId(stagingId);
    validateDigest(digest);
    if (size < 0n) throw new ArtifactBlobStoreError('size must be non-negative', 'invalid_size');
    await this.ensureRoots();
    const committedPath = this.committedDataPath(digest);
    const committedMetadataPath = this.committedMetadataPath(digest);
    const committedLocator = this.committedLocator(digest);
    if (await exists(committedPath)) {
      await this.assertCommittedMatches(digest, size);
      await this.removeStaged(stagingId);
      return { digest, size, committedLocator };
    }

    if (!(await exists(this.stagedDataPath(stagingId)))) {
      throw new ArtifactBlobStoreError(`staged object ${stagingId} was not found`, 'not_found');
    }
    const staged = await this.readStagedMetadata(stagingId);
    if (staged.digest !== digest) throw new ArtifactBlobStoreError('staged digest does not match promotion digest', 'digest_mismatch');
    if (staged.size !== size) throw new ArtifactBlobStoreError('staged size does not match promotion size', 'size_mismatch');

    await mkdir(dirname(committedPath), { recursive: true });
    const temp = join(this.temporaryRoot, `${digest}.${randomUUID()}.commit.tmp`);
    await pipeline(createReadStream(this.stagedDataPath(stagingId)), createWriteStream(temp, { flags: 'wx' }));
    try {
      await link(temp, committedPath);
    } catch (error: unknown) {
      await rm(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') await this.assertCommittedMatches(digest, size);
      else throw error;
    }
    await writeFile(committedMetadataPath, JSON.stringify({ digest, size: size.toString() }) + '\n', { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      await this.assertCommittedMatches(digest, size);
    });
    await this.removeStaged(stagingId);
    return { digest, size, committedLocator };
  }

  async readCommitted(digest: HexSha256Digest): Promise<Readable> {
    validateDigest(digest);
    const path = this.committedDataPath(digest);
    await assertRegularExisting(path);
    return createReadStream(path);
  }

  async removeStaged(stagingId: StagingId): Promise<void> {
    validateStagingId(stagingId);
    await rm(this.stagedDataPath(stagingId), { force: true });
    await rm(this.stagedMetadataPath(stagingId), { force: true });
  }

  async stagedExists(stagingId: StagingId): Promise<boolean> {
    validateStagingId(stagingId);
    return exists(this.stagedDataPath(stagingId));
  }

  async committedExists(digest: HexSha256Digest): Promise<boolean> {
    validateDigest(digest);
    return exists(this.committedDataPath(digest));
  }

  async listStaged(options: ListStagedOptions): Promise<StagedObjectPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000');
    const entries = await readdirSafe(this.stagingRoot);
    const ids = entries.filter((entry) => entry.endsWith('.blob')).map((entry) => entry.slice(0, -5)).sort();
    const cursor = options.cursor;
    const start = cursor === undefined ? 0 : ids.findIndex((id) => id > cursor);
    const slice = ids.slice(start < 0 ? ids.length : start, (start < 0 ? ids.length : start) + options.limit);
    const objects = await Promise.all(slice.map(async (id) => this.readStagedMetadata(id).then((metadata) => this.stagingReceipt(id, metadata.digest, metadata.size))));
    const last = slice.at(-1);
    const nextCursor = last !== undefined && ids.some((id) => id > last) ? last : undefined;
    return { objects, nextCursor };
  }

  private stagingReceipt(stagingId: string, digest: string, size: bigint): StagingReceipt {
    return { stagingId, digest, size, stagedLocator: `file:staging/${stagingId}` };
  }
  private committedLocator(digest: string): string { return `file:committed/sha256/${digest.slice(0, 2)}/${digest}`; }
  private stagedDataPath(id: string): string { return safeJoin(this.stagingRoot, `${id}.blob`); }
  private stagedMetadataPath(id: string): string { return safeJoin(this.stagingRoot, `${id}.json`); }
  private committedDataPath(digest: string): string { return safeJoin(this.committedRoot, 'sha256', digest.slice(0, 2), digest); }
  private committedMetadataPath(digest: string): string { return `${this.committedDataPath(digest)}.json`; }
  private async ensureRoots(): Promise<void> { await Promise.all([mkdir(this.stagingRoot, { recursive: true }), mkdir(this.committedRoot, { recursive: true }), mkdir(this.temporaryRoot, { recursive: true })]); }
  private async readStagedMetadata(id: string): Promise<{ digest: string; size: bigint }> { return readMetadata(this.stagedMetadataPath(id)); }
  private async assertCommittedMatches(digest: string, size: bigint): Promise<void> {
    const actual = await readMetadata(this.committedMetadataPath(digest));
    if (actual.digest !== digest || actual.size !== size) throw new ArtifactBlobStoreError('committed object conflicts with requested digest or size', 'committed_conflict');
  }
}

export function validateStagingId(stagingId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stagingId) || stagingId.includes('..')) throw new ArtifactBlobStoreError('invalid staging id', 'invalid_staging_id');
}

export function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new ArtifactBlobStoreError('invalid SHA-256 digest', 'invalid_digest');
}

function safeJoin(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (path !== root && !path.startsWith(prefix)) throw new ArtifactBlobStoreError('resolved path escaped storage root', 'invalid_staging_id');
  return path;
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function assertRegularExisting(path: string): Promise<void> { try { const s = await lstat(path); if (!s.isFile()) throw new ArtifactBlobStoreError('object is not a regular file', 'not_found'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactBlobStoreError('object not found', 'not_found'); throw e; } }
async function readMetadata(path: string): Promise<{ digest: string; size: bigint }> { try { const data = JSON.parse(await readFile(path, 'utf8')) as SidecarMetadata; validateDigest(data.digest); return { digest: data.digest, size: BigInt(data.size) }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactBlobStoreError('object metadata not found', 'not_found'); throw e; } }
async function readdirSafe(path: string): Promise<string[]> { return readdir(path).catch(() => []); }
