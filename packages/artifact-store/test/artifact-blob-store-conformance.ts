import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  ArtifactBlobStoreError,
  type ArtifactBlobStore,
} from '../src/index.js';

const digestOf = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const chunks = (...parts: string[]) =>
  Readable.from(parts.map((part) => Buffer.from(part)));
const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(buffers).toString('utf8');
};

export interface ArtifactBlobStoreTestHarness {
  createStore(): Promise<ArtifactBlobStore>;
  corruptStaged?(stagingId: string, bytes: Uint8Array): Promise<void>;
  corruptCommitted?(digest: string, bytes: Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
}

export function artifactBlobStoreConformance(
  createHarness: (root: string) => ArtifactBlobStoreTestHarness,
) {
  let root: string;
  let store: ArtifactBlobStore;
  let harness: ArtifactBlobStoreTestHarness;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    harness = createHarness(root);
    store = await harness.createStore();
  });
  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it('stages and reads streams while computing digest and size', async () => {
    const receipt = await store.stage(
      'stage-one',
      chunks('hello', ' ', 'world'),
    );
    expect(receipt.digest).toBe(digestOf('hello world'));
    expect(receipt.size).toBe(11n);
    expect(await readAll(await store.readStaged('stage-one'))).toBe(
      'hello world',
    );
  });

  it('rejects expected digest mismatch and cleans up partial staging data', async () => {
    await expect(
      store.stage('bad-digest', chunks('abc'), {
        expectedDigest: digestOf('other'),
      }),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(await store.stagedExists('bad-digest')).toBe(false);
  });

  it('rejects expected size mismatch and cleans up partial staging data', async () => {
    await expect(
      store.stage('bad-size', chunks('abc'), { expectedSize: 4n }),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    expect(await store.stagedExists('bad-size')).toBe(false);
  });

  it('cleans up partial writes when the source stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('boom'));
      },
    });
    await expect(store.stage('partial', failing)).rejects.toThrow('boom');
    expect(await store.stagedExists('partial')).toBe(false);
  });

  it('is idempotent for same staging id and identical content', async () => {
    const first = await store.stage('same', chunks('abc'));
    const second = await store.stage('same', chunks('abc'));
    expect(second).toEqual(first);
  });

  it('rejects same staging id with conflicting content', async () => {
    await store.stage('same', chunks('abc'));
    await expect(store.stage('same', chunks('def'))).rejects.toMatchObject({
      code: 'staging_conflict',
    });
  });

  it('allows identical content under different staging ids', async () => {
    const first = await store.stage('one', chunks('abc'));
    const second = await store.stage('two', chunks('abc'));
    expect(second.digest).toBe(first.digest);
    expect(await store.stagedExists('one')).toBe(true);
    expect(await store.stagedExists('two')).toBe(true);
  });

  it('promotes staged content and supports repeated promotion', async () => {
    const staged = await store.stage('promote-me', chunks('abc'));
    const committed = await store.promote(
      staged.stagingId,
      staged.digest,
      staged.size,
    );
    expect(committed.digest).toBe(staged.digest);
    expect(await store.stagedExists(staged.stagingId)).toBe(false);
    expect(await store.committedExists(staged.digest)).toBe(true);
    expect(await readAll(await store.readCommitted(staged.digest))).toBe('abc');
    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).resolves.toEqual(committed);
  });

  it('promotes successfully after staged source disappeared when committed exists', async () => {
    const staged = await store.stage('retry-promote', chunks('abc'));
    await store.promote(staged.stagingId, staged.digest, staged.size);
    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).resolves.toMatchObject({ digest: staged.digest, size: staged.size });
  });

  it('detects committed-content conflicts', async () => {
    const staged = await store.stage('conflict', chunks('abc'));
    await store.promote(staged.stagingId, staged.digest, staged.size);
    await store.stage('conflict-source', chunks('abc'));
    await expect(
      store.promote('conflict-source', staged.digest, 999n),
    ).rejects.toMatchObject({ code: 'committed_conflict' });
  });

  it('removes staged content', async () => {
    await store.stage('remove-me', chunks('abc'));
    await store.removeStaged('remove-me');
    expect(await store.stagedExists('remove-me')).toBe(false);
  });

  it('checks staged and committed existence', async () => {
    const staged = await store.stage('exists', chunks('abc'));
    expect(await store.stagedExists('exists')).toBe(true);
    expect(await store.committedExists(staged.digest)).toBe(false);
    await store.promote('exists', staged.digest, staged.size);
    expect(await store.committedExists(staged.digest)).toBe(true);
  });

  it('lists staged objects with bounded pagination', async () => {
    await store.stage('c', chunks('c'));
    await store.stage('a', chunks('a'));
    await store.stage('b', chunks('b'));
    const first = await store.listStaged({ limit: 2 });
    expect(first.objects.map((object) => object.stagingId)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await store.listStaged({
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.objects.map((object) => object.stagingId)).toEqual(['c']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects malicious or malformed staging ids and digests', async () => {
    await expect(store.stage('../escape', chunks('x'))).rejects.toBeInstanceOf(
      ArtifactBlobStoreError,
    );
    await expect(store.readStaged('nested/path')).rejects.toBeInstanceOf(
      ArtifactBlobStoreError,
    );
    await expect(store.readCommitted('ABC')).rejects.toMatchObject({
      code: 'invalid_digest',
    });
  });

  it('supports empty artifacts', async () => {
    const staged = await store.stage('empty', chunks(''));
    expect(staged.size).toBe(0n);
    expect(staged.digest).toBe(digestOf(''));
    await store.promote('empty', staged.digest, staged.size);
    expect(await readAll(await store.readCommitted(staged.digest))).toBe('');
  });

  it('handles concurrent identical staging publication idempotently', async () => {
    const [first, second] = await Promise.all([
      store.stage('race', chunks('abc')),
      store.stage('race', chunks('abc')),
    ]);
    expect(second).toEqual(first);
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
  });

  it('rejects same-length staged data tampering during promotion when harness supports corruption', async () => {
    if (harness.corruptStaged === undefined) return;
    const staged = await store.stage('tampered-digest', chunks('abc'));
    await harness.corruptStaged(staged.stagingId, Buffer.from('xyz'));
    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(await store.stagedExists(staged.stagingId)).toBe(false);
    expect(await store.committedExists(staged.digest)).toBe(false);
  });

  it('rejects different-length staged data tampering during promotion when harness supports corruption', async () => {
    if (harness.corruptStaged === undefined) return;
    const staged = await store.stage('tampered-size', chunks('abc'));
    await harness.corruptStaged(staged.stagingId, Buffer.from('abcdef'));
    await expect(
      store.promote(staged.stagingId, staged.digest, staged.size),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    expect(await store.stagedExists(staged.stagingId)).toBe(false);
    expect(await store.committedExists(staged.digest)).toBe(false);
  });

  it('rejects an existing committed object whose bytes do not match its metadata when harness supports corruption', async () => {
    if (harness.corruptCommitted === undefined) return;
    const first = await store.stage('first-source', chunks('abc'));
    await store.promote(first.stagingId, first.digest, first.size);
    await harness.corruptCommitted(first.digest, Buffer.from('xyz'));
    const retry = await store.stage('retry-source', chunks('abc'));
    await expect(
      store.promote(retry.stagingId, retry.digest, retry.size),
    ).rejects.toMatchObject({ code: 'committed_conflict' });
    expect(await store.stagedExists(retry.stagingId)).toBe(true);
    expect(await store.committedExists(first.digest)).toBe(false);
  });
}
