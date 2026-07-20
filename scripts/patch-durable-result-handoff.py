from pathlib import Path
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one {label} match, found {count}")
    return text.replace(old, new)


database_path = Path("packages/db/src/database.ts")
database = database_path.read_text()
database = replace_once(
    database,
    dedent(
        """\
          worker_result_submissions: Row & {
            execution_id: string;
            attempt_id: string;
            submission_digest: string;
            result: Jsonb;
          };
        """
    ),
    dedent(
        """\
          worker_result_submissions: Row & {
            execution_id: string;
            attempt_id: string;
            submission_digest: string;
            result: Jsonb;
            committed_at: Timestamp | null;
          };
        """
    ),
    "database type",
)
database_path.write_text(database)

worker_path = Path("packages/runtime-core/src/worker/worker-protocol-service.ts")
worker = worker_path.read_text()
worker = replace_once(
    worker,
    dedent(
        """\
        export interface WorkerProtocolOptions {
          leaseDurationMs: number;
          baseUrl?: string;
        }
        """
    ),
    dedent(
        """\
        export interface WorkerProtocolOptions {
          leaseDurationMs: number;
          baseUrl?: string;
          afterResultHandoffCommitted?: (input: {
            executionId: string;
            attemptId: string;
            submissionDigest: string;
          }) => void | Promise<void>;
        }
        """
    ),
    "worker options",
)
start = worker.index("  async submitResult(input: ProposedResultInput) {")
end = worker.index("\n  async invokeCapability(", start)
new_submit = dedent(
    """\
      async submitResult(input: ProposedResultInput) {
        const attempt = normalizeAttemptIdentity(input);
        const stagedArtifacts = input.stagedArtifacts.map(normalizeStagedArtifact);
        const proposedState = input.proposedState
          ? normalizeStagedArtifact(input.proposedState)
          : undefined;
        const digest = canonicalJsonDigest(input);
        const commitInput = {
          protocolVersion: input.protocolVersion,
          executionId: attempt.executionId,
          attemptId: attempt.attemptId,
          leaseToken: attempt.leaseToken,
          lifecycleEpoch: attempt.regionFencingEpoch,
          status: input.status,
          stagedArtifacts: stagedArtifacts.map(toWorkerV1StagedArtifact),
          proposedEvents: input.proposedEvents,
          externalActionProposals: input.externalActionProposals,
          resourceUsage: input.resourceUsage,
          ...(proposedState
            ? { proposedState: toWorkerV1StagedArtifact(proposedState) }
            : {}),
          ...(input.failure === undefined ? {} : { failure: input.failure }),
        };
        const handoff = await this.db.transaction().execute(async (transaction) => {
          const existing = await transaction
            .selectFrom('worker_result_submissions')
            .select('submission_digest')
            .where('attempt_id', '=', attempt.attemptId)
            .executeTakeFirst();
          if (existing) {
            if (existing.submission_digest === digest)
              return { duplicate: true as const };
            throw new WorkerProtocolError(
              'duplicate_conflicting_result',
              'attempt already has a different proposed result',
              false,
              409,
            );
          }
          const inserted = await transaction
            .insertInto('worker_result_submissions')
            .values({
              id: createUuidV7(),
              execution_id: attempt.executionId,
              attempt_id: attempt.attemptId,
              submission_digest: digest,
              result: commitInput as unknown as Json,
              committed_at: null,
            })
            .onConflict((conflict) => conflict.column('attempt_id').doNothing())
            .returning('submission_digest')
            .executeTakeFirst();
          if (!inserted) {
            const concurrent = await transaction
              .selectFrom('worker_result_submissions')
              .select('submission_digest')
              .where('attempt_id', '=', attempt.attemptId)
              .executeTakeFirstOrThrow();
            if (concurrent.submission_digest === digest)
              return { duplicate: true as const };
            throw new WorkerProtocolError(
              'duplicate_conflicting_result',
              'attempt already has a different proposed result',
              false,
              409,
            );
          }
          await this.activeAttempt(attempt, transaction, true);
          await this.validateStagedArtifacts(transaction, attempt.attemptId, [
            ...stagedArtifacts,
            ...(proposedState ? [proposedState] : []),
          ]);
          return { duplicate: false as const };
        });
        await this.options.afterResultHandoffCommitted?.({
          executionId: attempt.executionId,
          attemptId: attempt.attemptId,
          submissionDigest: digest,
        });
        try {
          await new ExecutionCommitService(
            this.db,
            this.blobStore,
            this.clock,
          ).commitSubmittedResult(attempt.attemptId);
        } catch (error) {
          if (error instanceof ExecutionCommitError)
            throw new WorkerProtocolError(
              error.code === 'external_action_unauthorized'
                ? 'capability_denied'
                : error.code === 'invalid_staged_artifact'
                  ? 'unauthorized_staging_reference'
                  : (error.code as WorkerErrorCode),
              error.message,
              error.statusCode >= 500,
              error.statusCode,
            );
          throw error;
        }
        return {
          protocolVersion: '1.0' as const,
          accepted: true,
          duplicate: handoff.duplicate,
          handoff: 'committed_by_control_plane' as const,
        };
      }
    """
)
worker_path.write_text(worker[:start] + new_submit + worker[end:])

commit_path = Path("packages/runtime-core/src/commit/execution-commit-service.ts")
commit = commit_path.read_text()
commit = replace_once(
    commit,
    "};\ntype Promotion = {\n",
    "};\ninterface CommitOptions {\n  allowExpiredLease?: boolean;\n}\ntype Promotion = {\n",
    "commit options type",
)
class_anchor = "export class ExecutionCommitService {"
normalize = dedent(
    """\
    function normalizeSubmittedResult(value: Json): ProposedExecutionResult {
      const raw = value as any;
      const normalizeStaged = (staged: any): Staged => ({
        ...staged,
        stagingId: staged.stagingId ?? staged.stagingRef,
      });
      return {
        ...raw,
        lifecycleEpoch: raw.lifecycleEpoch ?? raw.regionFencingEpoch,
        stagedArtifacts: Array.isArray(raw.stagedArtifacts)
          ? raw.stagedArtifacts.map(normalizeStaged)
          : [],
        ...(raw.proposedState
          ? { proposedState: normalizeStaged(raw.proposedState) }
          : {}),
      } as ProposedExecutionResult;
    }

    """
)
commit = replace_once(commit, class_anchor, normalize + class_anchor, "commit class anchor")
method_start = commit.index("  async commitSubmittedResult(attemptId: string) {")
method_end = commit.index("\n  async commit(", method_start)
new_method = dedent(
    """\
      async commitSubmittedResult(
        attemptId: string,
        options: CommitOptions = {},
      ) {
        const submission = await this.db
          .selectFrom('worker_result_submissions')
          .selectAll()
          .where('attempt_id', '=', attemptId)
          .executeTakeFirstOrThrow();
        return this.commit(
          normalizeSubmittedResult(submission.result),
          submission.submission_digest,
          options,
        );
      }
    """
)
commit = commit[:method_start] + new_method + commit[method_end:]
commit = replace_once(
    commit,
    dedent(
        """\
          async commit(
            input: ProposedExecutionResult,
            submissionDigest = canonicalJsonDigest(input),
          ) {
        """
    ),
    dedent(
        """\
          async commit(
            input: ProposedExecutionResult,
            submissionDigest = canonicalJsonDigest(input),
            options: CommitOptions = {},
          ) {
        """
    ),
    "commit signature",
)
commit = replace_once(
    commit,
    dedent(
        """\
                if (submission && submission.submission_digest !== submissionDigest)
                  throw new ExecutionCommitError(
                    'duplicate_conflicting_result',
                    'attempt already has a different proposed result',
                  );
                if (!['leased', 'running'].includes(attempt.status)) {
                  if (submission) return { disposition: 'duplicate' as const };
        """
    ),
    dedent(
        """\
                if (submission && submission.submission_digest !== submissionDigest)
                  throw new ExecutionCommitError(
                    'duplicate_conflicting_result',
                    'attempt already has a different proposed result',
                  );
                if (submission?.committed_at)
                  return { disposition: 'duplicate' as const };
                if (!['leased', 'running'].includes(attempt.status)) {
        """
    ),
    "terminal attempt handling",
)
commit = replace_once(
    commit,
    dedent(
        """\
                if (execution.status !== 'running') {
                  if (submission) return { disposition: 'duplicate' as const };
                  throw new ExecutionCommitError(
        """
    ),
    dedent(
        """\
                if (execution.status !== 'running') {
                  throw new ExecutionCommitError(
        """
    ),
    "terminal execution handling",
)
commit = replace_once(
    commit,
    "        this.assertAuthority(input, attempt, execution, region, deliveries);",
    dedent(
        """\
                this.assertAuthority(
                  input,
                  attempt,
                  execution,
                  region,
                  deliveries,
                  options.allowExpiredLease === true,
                );
        """
    ).rstrip(),
    "authority invocation",
)
commit = replace_once(
    commit,
    dedent(
        """\
                if (input.status === 'completed')
                  return this.complete(
                    trx,
                    input,
                    execution,
                    component,
                    deliveries,
                    artifactIds,
                  );
                return this.failOrRetry(trx, input, execution, attempt, deliveries);
        """
    ),
    dedent(
        """\
                const disposition =
                  input.status === 'completed'
                    ? await this.complete(
                        trx,
                        input,
                        execution,
                        component,
                        deliveries,
                        artifactIds,
                      )
                    : await this.failOrRetry(
                        trx,
                        input,
                        execution,
                        attempt,
                        deliveries,
                      );
                await trx
                  .updateTable('worker_result_submissions')
                  .set({ committed_at: this.clock() })
                  .where('attempt_id', '=', input.attemptId)
                  .where('submission_digest', '=', submissionDigest)
                  .where('committed_at', 'is', null)
                  .executeTakeFirstOrThrow();
                return disposition;
        """
    ),
    "commit outcome",
)
commit = replace_once(
    commit,
    dedent(
        """\
                  .where('attempt_id', '=', input.attemptId)
                  .where('submission_digest', '=', submissionDigest)
                  .execute();
        """
    ),
    dedent(
        """\
                  .where('attempt_id', '=', input.attemptId)
                  .where('submission_digest', '=', submissionDigest)
                  .where('committed_at', 'is', null)
                  .execute();
        """
    ),
    "pending submission cleanup",
)
commit = replace_once(
    commit,
    dedent(
        """\
          private assertAuthority(
            input: ProposedExecutionResult,
            attempt: any,
            execution: any,
            region: any,
            deliveries: any[],
          ) {
        """
    ),
    dedent(
        """\
          private assertAuthority(
            input: ProposedExecutionResult,
            attempt: any,
            execution: any,
            region: any,
            deliveries: any[],
            allowExpiredLease: boolean,
          ) {
        """
    ),
    "authority signature",
)
commit = replace_once(
    commit,
    dedent(
        """\
            if (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock())
              throw new ExecutionCommitError('lease_expired', 'lease has expired');
        """
    ),
    dedent(
        """\
            if (
              !allowExpiredLease &&
              (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock())
            )
              throw new ExecutionCommitError('lease_expired', 'lease has expired');
        """
    ),
    "lease expiry authority",
)
commit_path.write_text(commit)

recovery_path = Path("packages/runtime-core/src/observability/recovery-service.ts")
recovery = recovery_path.read_text()
import_anchor = dedent(
    """\
    import {
      type ExternalActionReconciliationReport,
      type ExternalActionService,
    } from '../external-actions/external-action-service.js';
    """
)
recovery = replace_once(
    recovery,
    import_anchor,
    import_anchor
    + dedent(
        """\
        import {
          ExecutionCommitError,
          ExecutionCommitService,
        } from '../commit/execution-commit-service.js';
        """
    ),
    "recovery import",
)
recovery = replace_once(
    recovery,
    "export interface StartupRecoverySummary {\n  expiredAttemptsAbandoned: number;",
    "export interface StartupRecoverySummary {\n  submittedResultsScanned: number;\n  submittedResultsCommitted: number;\n  submittedResultsRejected: number;\n  expiredAttemptsAbandoned: number;",
    "recovery summary",
)
recovery = replace_once(
    recovery,
    "      externalActionReconciliationBatchSize?: number;\n      removeOrphanArtifacts?: boolean;",
    "      externalActionReconciliationBatchSize?: number;\n      resultCommitBatchSize?: number;\n      removeOrphanArtifacts?: boolean;",
    "recovery options",
)
recovery = replace_once(
    recovery,
    "    const now = options.now ?? this.clock();\n    const expiredAttemptIds = await this.db",
    dedent(
        """\
            const now = options.now ?? this.clock();
            const pendingSubmissions = await this.db
              .selectFrom('worker_result_submissions')
              .select('attempt_id')
              .where('committed_at', 'is', null)
              .orderBy('created_at')
              .orderBy('id')
              .limit(options.resultCommitBatchSize ?? 100)
              .execute();
            const resultCommit = new ExecutionCommitService(
              this.db,
              this.deps.blobStore,
              this.clock,
            );
            let submittedResultsScanned = 0;
            let submittedResultsCommitted = 0;
            let submittedResultsRejected = 0;
            for (const submission of pendingSubmissions) {
              submittedResultsScanned++;
              try {
                await resultCommit.commitSubmittedResult(submission.attempt_id, {
                  allowExpiredLease: true,
                });
                submittedResultsCommitted++;
              } catch (error) {
                if (error instanceof ExecutionCommitError && error.statusCode < 500) {
                  submittedResultsRejected++;
                  continue;
                }
                throw error;
              }
            }

            const expiredAttemptIds = await this.db
        """
    ).rstrip(),
    "recovery start",
)
recovery = replace_once(
    recovery,
    "    const recoveryPayload: Json = {\n      expiredAttemptsAbandoned,",
    "    const recoveryPayload: Json = {\n      submittedResultsScanned,\n      submittedResultsCommitted,\n      submittedResultsRejected,\n      expiredAttemptsAbandoned,",
    "recovery payload",
)
recovery = replace_once(
    recovery,
    "    return {\n      expiredAttemptsAbandoned,",
    "    return {\n      submittedResultsScanned,\n      submittedResultsCommitted,\n      submittedResultsRejected,\n      expiredAttemptsAbandoned,",
    "recovery return",
)
recovery_path.write_text(recovery)
