import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3ArtifactBlobStore, type ArtifactBlobStore } from '../src/public.js';

export interface MinioArtifactStoreFixture {
  readonly blobStore: ArtifactBlobStore;
  readonly expectedStagedLocatorPrefix: string;
  cleanup(): Promise<void>;
}

const endpoint =
  process.env.MINIO_ENDPOINT ??
  process.env.FACTORY_FLOOR_MINIO_ENDPOINT ??
  'http://127.0.0.1:9000';
const region = process.env.MINIO_REGION ?? 'us-east-1';
const credentials = {
  accessKeyId:
    process.env.MINIO_ACCESS_KEY ??
    process.env.MINIO_ROOT_USER ??
    'factoryfloor',
  secretAccessKey:
    process.env.MINIO_SECRET_KEY ??
    process.env.MINIO_ROOT_PASSWORD ??
    'factoryfloor_dev_password',
};

export async function createMinioArtifactStoreFixture(): Promise<MinioArtifactStoreFixture> {
  const bucket = `ff-artifact-fault-${randomUUID()}`;
  const prefix = `reconciliation/${randomUUID()}`;
  const client = new S3Client({
    endpoint,
    region,
    credentials,
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  let cleaned = false;

  return {
    blobStore: new S3ArtifactBlobStore({
      endpoint,
      region,
      bucket,
      prefix,
      forcePathStyle: true,
      clientConfig: { credentials },
    }),
    expectedStagedLocatorPrefix: `s3://${bucket}/${prefix}/staging/`,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await emptyBucket(client, bucket);
      await client
        .send(new DeleteBucketCommand({ Bucket: bucket }))
        .catch(() => undefined);
      client.destroy();
    },
  };
}

async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  while (true) {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    const objects = (listed.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    if (listed.IsTruncated !== true) return;
  }
}
