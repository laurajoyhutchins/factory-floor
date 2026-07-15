import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactBlobStoreConformance } from '../test/artifact-blob-store-conformance.js';
import { S3ArtifactBlobStore } from './public.js';

const endpoint = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
const region = process.env.MINIO_REGION ?? 'us-east-1';
const credentials = {
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'factoryfloor',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'factoryfloor_dev_password',
};

const createClient = () => new S3Client({ endpoint, region, credentials, forcePathStyle: true });
const chunks = (...parts: string[]) => Readable.from(parts.map((part) => Buffer.from(part)));
const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(buffers).toString('utf8');
};
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
const metadata = (bytes: string) => ({
  digest: digestOf(bytes),
  size: Buffer.byteLength(bytes).toString(),
  format: 'factory-floor-artifact-blob',
  version: '1',
});

describe('S3ArtifactBlobStore MinIO conformance', () => {
  artifactBlobStoreConformance(() => {
    const bucket = `ff-artifact-${randomUUID()}`;
    const prefix = `suite/${randomUUID()}`;
    const client = createClient();
    return {
      createStore: async () => {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        return new S3ArtifactBlobStore({ endpoint, region, bucket, prefix, forcePathStyle: true, clientConfig: { credentials } });
      },
      corruptStaged: async (stagingId, bytes) => {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/staging/${stagingId}`,
          Body: bytes,
          Metadata: metadata('abc'),
        }));
      },
      corruptCommitted: async (digest, bytes) => {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/committed/sha256/${digest.slice(0, 2)}/${digest}`,
          Body: bytes,
          Metadata: metadata('abc'),
        }));
      },
      cleanup: async () => {
        await emptyBucket(client, bucket);
        await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
      },
    };
  });
});

describe('S3ArtifactBlobStore MinIO behavior', () => {
  const bucket = `ff-artifact-${randomUUID()}`;
  const prefix = `specific/${randomUUID()}`;
  const client = createClient();
  let store: S3ArtifactBlobStore;

  beforeEach(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    store = new S3ArtifactBlobStore({ endpoint, region, bucket, prefix, forcePathStyle: true, clientConfig: { credentials } });
  });

  afterEach(async () => {
    await emptyBucket(client, bucket);
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  });

  it('streams multi-chunk content and returns opaque locators without credentials', async () => {
    const staged = await store.stage('multi', chunks('a'.repeat(64 * 1024), 'b'.repeat(64 * 1024), 'c'));
    expect(staged.stagedLocator).toBe(`s3://${bucket}/${prefix}/staging/multi`);
    expect(staged.stagedLocator).not.toContain(credentials.secretAccessKey);
    expect(await readAll(await store.readStaged('multi'))).toHaveLength(128 * 1024 + 1);
  });

  it('does not expose incomplete tmp objects through reads, existence, locators, or listing', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/tmp/orphan`, Body: 'abc' }));
    expect(await store.stagedExists('orphan')).toBe(false);
    await expect(store.readStaged('orphan')).rejects.toMatchObject({ code: 'not_found' });
    const page = await store.listStaged({ limit: 10 });
    expect(page.objects).toEqual([]);
  });

  it('keeps promotion safely retryable after committed publication but before staged cleanup', async () => {
    const staged = await store.stage('left-behind', chunks('abc'));
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/committed/sha256/${staged.digest.slice(0, 2)}/${staged.digest}`,
      Body: 'abc',
      Metadata: metadata('abc'),
    }));
    await expect(store.promote('left-behind', staged.digest, staged.size)).resolves.toMatchObject({ digest: staged.digest });
    expect(await store.stagedExists('left-behind')).toBe(false);
  });

  it('uses opaque S3 pagination cursors', async () => {
    await store.stage('a', chunks('a'));
    await store.stage('b', chunks('b'));
    const first = await store.listStaged({ limit: 1 });
    expect(first.objects).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(first.nextCursor).not.toBe(first.objects[0]?.stagingId);
  });
});

async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  while (true) {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (listed.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [{ Key: object.Key }]));
    if (objects.length > 0) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    if (listed.IsTruncated !== true) break;
  }
}
