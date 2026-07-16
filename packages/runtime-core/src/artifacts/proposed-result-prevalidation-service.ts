import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import {
  ArtifactRepository,
  type Database,
} from '@factory-floor/db';
import type { Kysely } from 'kysely';
import { ArtifactDomainError } from './errors.js';
import { ArtifactValidationService } from './artifact-validation-service.js';

type StagedReference = { stagingId?: unknown };
type ProposedResultLike = {
  attemptId?: unknown;
  status?: unknown;
  stagedArtifacts?: unknown;
  proposedState?: unknown;
  externalActionProposals?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ProposedResultPrevalidationService {
  private readonly repository = new ArtifactRepository();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly blobStore: ArtifactBlobStore,
    private readonly maxJsonBytes = 104_857_600n,
  ) {}

  async prevalidate(input: ProposedResultLike): Promise<void> {
    if (input.status !== 'completed') return;
    if (typeof input.attemptId !== 'string')
      throw new ArtifactDomainError(
        'staging_not_found',
        'completed result is missing its attempt identity',
      );

    const references: StagedReference[] = [];
    if (Array.isArray(input.stagedArtifacts))
      references.push(...(input.stagedArtifacts as StagedReference[]));
    if (isRecord(input.proposedState))
      references.push(input.proposedState as StagedReference);
    if (Array.isArray(input.externalActionProposals))
      for (const proposal of input.externalActionProposals)
        if (isRecord(proposal) && isRecord(proposal.requestArtifact))
          references.push(proposal.requestArtifact as StagedReference);

    const stagedRefs = [
      ...new Set(
        references.map((reference) => reference.stagingId).filter(
          (stagingId): stagingId is string => typeof stagingId === 'string',
        ),
      ),
    ];
    if (stagedRefs.length === 0) return;

    const rows = await this.db
      .selectFrom('artifact_staging')
      .select(['id', 'staged_ref'])
      .where('attempt_id', '=', input.attemptId)
      .where('staged_ref', 'in', stagedRefs)
      .execute();
    if (rows.length !== stagedRefs.length)
      throw new ArtifactDomainError(
        'staging_not_found',
        'a proposed result references unknown staged content',
      );

    const validation = new ArtifactValidationService({
      db: this.db,
      repository: this.repository,
      blobStore: this.blobStore,
      maxJsonBytes: this.maxJsonBytes,
    });
    for (const row of rows) await validation.validateStagedArtifact(row.id);
  }
}
