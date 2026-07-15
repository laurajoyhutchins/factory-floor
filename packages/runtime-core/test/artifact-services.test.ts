import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactDomainError,
  ArtifactReconciliationService,
  decodeArtifactReconciliationCursor,
  encodeArtifactReconciliationCursor,
  isJsonMediaType,
} from '../src/index.js';

describe('artifact domain helpers', () => {
  it('classifies JSON media types narrowly', () => {
    expect(isJsonMediaType('application/json')).toBe(true);
    expect(
      isJsonMediaType('application/vnd.factory+json; charset=utf-8'),
    ).toBe(true);
    expect(isJsonMediaType('text/json')).toBe(false);
    expect(isJsonMediaType('application/octet-stream')).toBe(false);
  });

  it('round trips opaque reconciliation cursors and rejects malformed input', () => {
    const cursor = encodeArtifactReconciliationCursor({ blob: 'token' });
    expect(cursor).not.toContain('token');
    expect(decodeArtifactReconciliationCursor(cursor)).toEqual({
      blob: 'token',
    });
    expect(() => decodeArtifactReconciliationCursor('not-json')).toThrow(
      ArtifactDomainError,
    );
    expect(() =>
      decodeArtifactReconciliationCursor(
        encodeArtifactReconciliationCursor({ blob: 42 }),
      ),
    ).toThrow(ArtifactDomainError);
  });

  it('resumes blob scans, honors orphan grace, and performs no dry-run mutations', async () => {
    const now = new Date('2026-07-15T05:00:00.000Z');
    const removeStaged = vi.fn();
    const markStagingAbandoned = vi.fn();
    const listStaged = vi.fn().mockResolvedValue({
      objects: [
        {
          stagingId: 'old',
          digest: 'a'.repeat(64),
          size: 1n,
          stagedLocator: 'staging/old',
          lastModifiedAt: new Date('2026-07-15T03:00:00.000Z'),
        },
        {
          stagingId: 'fresh',
          digest: 'b'.repeat(64),
          size: 1n,
          stagedLocator: 'staging/fresh',
          lastModifiedAt: new Date('2026-07-15T04:30:00.000Z'),
        },
      ],
    });
    const repository = {
      findCommittedArtifactsNeedingBlobCheck: vi.fn().mockResolvedValue([]),
      listReconciliationCandidates: vi.fn().mockResolvedValue([]),
      readStagingRowsByLocator: vi.fn().mockResolvedValue([]),
      markStagingAbandoned,
    };
    const blobStore = {
      listStaged,
      removeStaged,
    };
    const service = new ArtifactReconciliationService({
      db: {} as never,
      repository: repository as never,
      blobStore: blobStore as never,
      clock: () => now,
    });

    const report = await service.runBatch({
      limit: 2,
      cursor: encodeArtifactReconciliationCursor({ blob: 'page-2' }),
      removeOrphans: true,
      orphanGraceSeconds: 3600,
      dryRun: true,
    });

    expect(listStaged).toHaveBeenCalledWith({ limit: 2, cursor: 'page-2' });
    expect(report.orphanStagedObjects).toBe(1);
    expect(report.wouldRemoveOrphanObjects).toBe(1);
    expect(report.removedOrphanObjects).toBe(0);
    expect(removeStaged).not.toHaveBeenCalled();
    expect(markStagingAbandoned).not.toHaveBeenCalled();
  });
});
