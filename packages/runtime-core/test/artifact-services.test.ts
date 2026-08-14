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
    expect(isJsonMediaType('application/vnd.factory+json; charset=utf-8')).toBe(
      true,
    );
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

  it('converges after promotion is interrupted between metadata commit and blob availability', async () => {
    const now = new Date('2026-07-15T05:00:00.000Z');
    const digest = 'c'.repeat(64);
    const artifact = { id: 'artifact-1', digest, size_bytes: '7' };
    const staging = {
      id: 'staging-1',
      artifact_id: 'artifact-1',
      staged_ref: 'staging/staging-1',
      status: 'staged',
    };
    let committed = false;
    let attempts = 0;
    const promote = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('injected promotion interruption');
      committed = true;
    });
    const markStagingPromoted = vi.fn();
    const repository = {
      findCommittedArtifactsNeedingBlobCheck: vi
        .fn()
        .mockResolvedValue([artifact]),
      readStagingRowsByArtifactId: vi.fn().mockResolvedValue([staging]),
      markStagingPromoted,
      listReconciliationCandidates: vi.fn().mockResolvedValue([]),
      readStagingRowsByLocator: vi.fn().mockResolvedValue([]),
    };
    const blobStore = {
      committedExists: vi.fn(async () => committed),
      promote,
      listStaged: vi.fn().mockResolvedValue({ objects: [] }),
    };
    const service = new ArtifactReconciliationService({
      db: {} as never,
      repository: repository as never,
      blobStore: blobStore as never,
      clock: () => now,
    });

    await expect(service.runBatch({ limit: 10 })).rejects.toThrow(
      'injected promotion interruption',
    );
    expect(markStagingPromoted).not.toHaveBeenCalled();

    const recovered = await service.runBatch({ limit: 10 });
    expect(recovered.promoted).toBe(1);
    expect(recovered.unresolved).toEqual([]);
    expect(promote).toHaveBeenCalledTimes(2);
    expect(markStagingPromoted).toHaveBeenCalledTimes(1);
    expect(markStagingPromoted).toHaveBeenCalledWith(
      expect.anything(),
      'staging-1',
      'artifact-1',
      now,
    );

    const stable = await service.runBatch({ limit: 10 });
    expect(stable.alreadyConsistent).toBe(1);
    expect(promote).toHaveBeenCalledTimes(2);
    expect(markStagingPromoted).toHaveBeenCalledTimes(1);
  });
});
