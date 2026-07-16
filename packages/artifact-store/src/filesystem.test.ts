import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactBlobStoreConformance } from '../test/artifact-blob-store-conformance.js';
import { FilesystemArtifactBlobStore } from './index.js';

const digestOf = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const chunks = (...parts: string[]) =>
  Readable.from(parts.map((part) => Buffer.from(part)));

describe('FilesystemArtifactBlobStore conformance', () => {
  artifactBlobStoreConformance((root) => ({
    createStore: async () => new FilesystemArtifactBlobStore(root),
    corruptStaged: async (stagingId, bytes) => {
      await writeFile(join(root, 'staging', stagingId, 'data'), bytes);
    },
    corruptCommitted: async (digest, bytes) => {
      await writeFile(
        join(root, 'committed', 'sha256', digest.slice(0, 2), digest, 'data'),
        bytes,
      );
    },
    cleanup: async () => undefined,
  }));
});

describe('FilesystemArtifactBlobStore filesystem safety and atomicity', () => {
  let root: string;
  let store: FilesystemArtifactBlobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-store-fs-'));
    store = new FilesystemArtifactBlobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not report interruption before staging publication', async () => {
    await mkdir(join(root, 'tmp', 'stage-orphan'), { recursive: true });
    await writeFile(join(root, 'tmp', 'stage-orphan', 'data'), 'abc');
    expect(await store.stagedExists('orphan')).toBe(false);
    await expect(store.readStaged('orphan')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await store.listStaged({ limit: 10 })).toEqual({ objects: [] });
  });

  it('does not report interruption after temporary data write but before metadata completion', async () => {
    await mkdir(join(root, 'tmp', 'stage-no-metadata'), { recursive: true });
    await writeFile(join(root, 'tmp', 'stage-no-metadata', 'data'), 'abc');
    expect(await store.stagedExists('stage-no-metadata')).toBe(false);
    expect(await store.committedExists(digestOf('abc'))).toBe(false);
  });

  it('retries promotion after committed publication but before staged cleanup', async () => {
    const staged = await store.stage('left-behind', chunks('abc'));
    const committedDirectory = join(
      root,
      'committed',
      'sha256',
      staged.digest.slice(0, 2),
      staged.digest,
    );
    await mkdir(committedDirectory, { recursive: true });
    await writeFile(join(committedDirectory, 'data'), 'abc');
    await writeFile(
      join(committedDirectory, 'metadata.json'),
      JSON.stringify({ digest: staged.digest, size: staged.size.toString() }) +
        '\n',
    );
    await expect(
      store.promote('left-behind', staged.digest, staged.size),
    ).resolves.toMatchObject({ digest: staged.digest, size: staged.size });
    expect(await store.stagedExists('left-behind')).toBe(false);
  });

  it('does not treat pre-existing incomplete staging objects as valid', async () => {
    await mkdir(join(root, 'staging', 'incomplete'), { recursive: true });
    await writeFile(join(root, 'staging', 'incomplete', 'data'), 'abc');
    expect(await store.stagedExists('incomplete')).toBe(false);
    await expect(store.readStaged('incomplete')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      store.stage('incomplete', chunks('abc')),
    ).rejects.toMatchObject({ code: 'staging_conflict' });
  });

  it('does not treat pre-existing incomplete committed objects as valid', async () => {
    const digest = digestOf('abc');
    await mkdir(join(root, 'committed', 'sha256', digest.slice(0, 2), digest), {
      recursive: true,
    });
    await writeFile(
      join(root, 'committed', 'sha256', digest.slice(0, 2), digest, 'data'),
      'abc',
    );
    expect(await store.committedExists(digest)).toBe(false);
    await expect(store.readCommitted(digest)).rejects.toMatchObject({
      code: 'not_found',
    });
    const staged = await store.stage('source', chunks('abc'));
    await expect(
      store.promote('source', staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'committed_conflict' });
  });

  it('handles concurrent identical staging publication idempotently', async () => {
    const [first, second] = await Promise.all([
      store.stage('race', chunks('abc')),
      store.stage('race', chunks('abc')),
    ]);
    expect(second).toEqual(first);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('handles concurrent conflicting staging publication as a conflict', async () => {
    const results = await Promise.allSettled([
      store.stage('race-conflict', chunks('abc')),
      store.stage('race-conflict', chunks('def')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'staging_conflict',
    });
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('removes temporary directories after successful promotion and handled failures', async () => {
    const staged = await store.stage('cleanup-success', chunks('abc'));
    await store.promote('cleanup-success', staged.digest, staged.size);
    expect(await tmpEntries(root)).toEqual([]);
    await expect(
      store.stage('cleanup-failure', chunks('abc'), { expectedSize: 999n }),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('rejects same-length staged data tampering during promotion', async () => {
    const staged = await store.stage('tampered-digest', chunks('abc'));
    await writeFile(join(root, 'staging', staged.stagingId, 'data'), 'xyz');

    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(await readdir(join(root, 'staging'))).toContain(staged.stagingId);
    expect(await store.committedExists(staged.digest)).toBe(false);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('rejects different-length staged data tampering during promotion', async () => {
    const staged = await store.stage('tampered-size', chunks('abc'));
    await writeFile(join(root, 'staging', staged.stagingId, 'data'), 'abcdef');

    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    expect(await readdir(join(root, 'staging'))).toContain(staged.stagingId);
    expect(await store.committedExists(staged.digest)).toBe(false);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('rejects an existing committed object whose bytes do not match its metadata', async () => {
    const first = await store.stage('first-source', chunks('abc'));
    await store.promote(first.stagingId, first.digest, first.size);
    const committedData = join(
      root,
      'committed',
      'sha256',
      first.digest.slice(0, 2),
      first.digest,
      'data',
    );
    await writeFile(committedData, 'xyz');
    const retry = await store.stage('retry-source', chunks('abc'));

    await expect(
      store.promote(retry.stagingId, retry.digest, retry.size),
    ).rejects.toMatchObject({ code: 'committed_conflict' });
    expect(await store.stagedExists(retry.stagingId)).toBe(true);
    expect(await store.committedExists(first.digest)).toBe(false);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('rejects symlinked staging namespace directories', async () => {
    await rm(join(root, 'staging'), { recursive: true, force: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, 'staging'));
    await expect(store.stage('escape', chunks('abc'))).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });

  it('rejects symlinked committed prefix directories', async () => {
    const staged = await store.stage('prefix-escape', chunks('abc'));
    await mkdir(join(root, 'outside-prefix'), { recursive: true });
    await mkdir(join(root, 'committed', 'sha256'), { recursive: true });
    await symlink(
      join(root, 'outside-prefix'),
      join(root, 'committed', 'sha256', staged.digest.slice(0, 2)),
    );
    await expect(
      store.promote('prefix-escape', staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('does not follow symlink escapes for final staged data files', async () => {
    await mkdir(join(root, 'staging', 'escape'), { recursive: true });
    await writeFile(join(root, 'outside'), 'secret');
    await symlink(
      join(root, 'outside'),
      join(root, 'staging', 'escape', 'data'),
    );
    await writeFile(
      join(root, 'staging', 'escape', 'metadata.json'),
      JSON.stringify({ digest: digestOf('secret'), size: '6' }) + '\n',
    );
    await expect(store.readStaged('escape')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

async function tmpEntries(root: string): Promise<string[]> {
  return readdir(join(root, 'tmp')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}
