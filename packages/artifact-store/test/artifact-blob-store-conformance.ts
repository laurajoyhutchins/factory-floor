import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArtifactBlobStoreError, type ArtifactBlobStore } from '../src/index.js';

const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
const chunks = (...parts: string[]) => Readable.from(parts.map((part) => Buffer.from(part)));
const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(buffers).toString('utf8');
};


export function artifactBlobStoreConformance(createStore: (root: string) => ArtifactBlobStore) {
  let root: string;
  let store: ArtifactBlobStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    store = createStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stages and reads streams while computing digest and size', async () => {
    const receipt = await store.stage('stage-one', chunks('hello', ' ', 'world'));
    expect(receipt.digest).toBe(digestOf('hello world'));
    expect(receipt.size).toBe(11n);
    expect(await readAll(await store.readStaged('stage-one'))).toBe('hello world');
  });

  it('rejects expected digest mismatch and cleans up partial staging data', async () => {
    await expect(store.stage('bad-digest', chunks('abc'), { expectedDigest: digestOf('other') })).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(await store.stagedExists('bad-digest')).toBe(false);
  });

  it('rejects expected size mismatch and cleans up partial staging data', async () => {
    await expect(store.stage('bad-size', chunks('abc'), { expectedSize: 4n })).rejects.toMatchObject({ code: 'size_mismatch' });
    expect(await store.stagedExists('bad-size')).toBe(false);
  });

  it('cleans up partial writes when the source stream fails', async () => {
    const failing = new Readable({ read() { this.push('partial'); this.destroy(new Error('boom')); } });
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
    await expect(store.stage('same', chunks('def'))).rejects.toMatchObject({ code: 'staging_conflict' });
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
    const committed = await store.promote(staged.stagingId, staged.digest, staged.size);
    expect(committed.digest).toBe(staged.digest);
    expect(await store.stagedExists(staged.stagingId)).toBe(false);
    expect(await store.committedExists(staged.digest)).toBe(true);
    expect(await readAll(await store.readCommitted(staged.digest))).toBe('abc');
    await expect(store.promote(staged.stagingId, staged.digest, staged.size)).resolves.toEqual(committed);
  });

  it('promotes successfully after staged source disappeared when committed exists', async () => {
    const staged = await store.stage('retry-promote', chunks('abc'));
    await store.promote(staged.stagingId, staged.digest, staged.size);
    await expect(store.promote(staged.stagingId, staged.digest, staged.size)).resolves.toMatchObject({ digest: staged.digest, size: staged.size });
  });

  it('detects committed-content conflicts', async () => {
    const staged = await store.stage('conflict', chunks('abc'));
    await store.promote(staged.stagingId, staged.digest, staged.size);
    await store.stage('conflict-source', chunks('abc'));
    await expect(store.promote('conflict-source', staged.digest, 999n)).rejects.toMatchObject({ code: 'committed_conflict' });
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
    expect(first.nextCursor).toBe('b');
    const second = await store.listStaged({ limit: 2, cursor: first.nextCursor });
    expect(second.objects.map((object) => object.stagingId)).toEqual(['c']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects malicious or malformed staging ids and digests', async () => {
    await expect(store.stage('../escape', chunks('x'))).rejects.toBeInstanceOf(ArtifactBlobStoreError);
    await expect(store.readStaged('nested/path')).rejects.toBeInstanceOf(ArtifactBlobStoreError);
    await expect(store.readCommitted('ABC')).rejects.toMatchObject({ code: 'invalid_digest' });
  });

  it('supports empty artifacts', async () => {
    const staged = await store.stage('empty', chunks(''));
    expect(staged.size).toBe(0n);
    expect(staged.digest).toBe(digestOf(''));
    await store.promote('empty', staged.digest, staged.size);
    expect(await readAll(await store.readCommitted(staged.digest))).toBe('');
  });

}
