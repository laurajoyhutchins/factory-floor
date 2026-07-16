import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactValidationService } from '../src/index.js';

describe('artifact validation receipts', () => {
  it('does not reread unchanged immutable staged bytes after validation', async () => {
    const bytes = Buffer.from('{"ok":true}');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const row = {
      id: `cache-${randomUUID()}`,
      staged_ref: `staged-${randomUUID()}`,
      status: 'staged',
      schema_id: 'schema-1',
      digest,
      size_bytes: String(bytes.length),
      media_type: 'application/json',
    };
    const schema = {
      id: 'schema-1',
      content_digest: 'a'.repeat(64),
      retired_at: null,
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { const: true } },
        additionalProperties: false,
      },
    };
    const repository = {
      readStagingById: vi.fn(async () => row),
      readArtifactSchemaById: vi.fn(async () => schema),
    };
    const readStaged = vi.fn(async () => Readable.from([bytes]));
    const service = new ArtifactValidationService({
      db: {} as never,
      repository: repository as never,
      blobStore: { readStaged } as never,
      maxJsonBytes: 1_024n,
    });

    await expect(service.validateStagedArtifact(row.id)).resolves.toMatchObject({
      cached: false,
      instance: { ok: true },
    });
    await expect(service.validateStagedArtifact(row.id)).resolves.toMatchObject({
      cached: true,
    });
    expect(readStaged).toHaveBeenCalledTimes(1);
  });
});
