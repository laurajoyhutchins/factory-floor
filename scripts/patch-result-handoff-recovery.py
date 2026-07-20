from pathlib import Path

path = Path('packages/runtime-core/src/observability/recovery-service.ts')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected one {label} match, found {count}')
    text = text.replace(old, new)


import_anchor = (
    "import {\n"
    "  type ExternalActionReconciliationReport,\n"
    "  type ExternalActionService,\n"
    "} from '../external-actions/external-action-service.js';\n"
)
replace_once(
    import_anchor,
    import_anchor
    + "import {\n"
    "  ExecutionCommitError,\n"
    "  ExecutionCommitService,\n"
    "} from '../commit/execution-commit-service.js';\n",
    'recovery import',
)

replace_once(
    "export interface StartupRecoverySummary {\n"
    "  expiredAttemptsAbandoned: number;\n",
    "export interface StartupRecoverySummary {\n"
    "  submittedResultsScanned: number;\n"
    "  submittedResultsCommitted: number;\n"
    "  submittedResultsRejected: number;\n"
    "  expiredAttemptsAbandoned: number;\n",
    'recovery summary',
)

replace_once(
    "      externalActionReconciliationBatchSize?: number;\n"
    "      removeOrphanArtifacts?: boolean;\n",
    "      externalActionReconciliationBatchSize?: number;\n"
    "      resultCommitBatchSize?: number;\n"
    "      removeOrphanArtifacts?: boolean;\n",
    'recovery options',
)

replace_once(
    "    const now = options.now ?? this.clock();\n"
    "    const expiredAttemptIds = await this.db\n",
    "    const now = options.now ?? this.clock();\n"
    "    const pendingSubmissions = await this.db\n"
    "      .selectFrom('worker_result_submissions')\n"
    "      .select('attempt_id')\n"
    "      .where('committed_at', 'is', null)\n"
    "      .orderBy('created_at')\n"
    "      .orderBy('id')\n"
    "      .limit(options.resultCommitBatchSize ?? 100)\n"
    "      .execute();\n"
    "    const resultCommit = new ExecutionCommitService(\n"
    "      this.db,\n"
    "      this.deps.blobStore,\n"
    "      this.clock,\n"
    "    );\n"
    "    let submittedResultsScanned = 0;\n"
    "    let submittedResultsCommitted = 0;\n"
    "    let submittedResultsRejected = 0;\n"
    "    for (const submission of pendingSubmissions) {\n"
    "      submittedResultsScanned++;\n"
    "      try {\n"
    "        await resultCommit.commitSubmittedResult(submission.attempt_id, {\n"
    "          allowExpiredLease: true,\n"
    "        });\n"
    "        submittedResultsCommitted++;\n"
    "      } catch (error) {\n"
    "        if (error instanceof ExecutionCommitError && error.statusCode < 500) {\n"
    "          submittedResultsRejected++;\n"
    "          continue;\n"
    "        }\n"
    "        throw error;\n"
    "      }\n"
    "    }\n\n"
    "    const expiredAttemptIds = await this.db\n",
    'recovery start',
)

replace_once(
    "    const recoveryPayload: Json = {\n"
    "      expiredAttemptsAbandoned,\n",
    "    const recoveryPayload: Json = {\n"
    "      submittedResultsScanned,\n"
    "      submittedResultsCommitted,\n"
    "      submittedResultsRejected,\n"
    "      expiredAttemptsAbandoned,\n",
    'recovery payload',
)

replace_once(
    "    return {\n"
    "      expiredAttemptsAbandoned,\n",
    "    return {\n"
    "      submittedResultsScanned,\n"
    "      submittedResultsCommitted,\n"
    "      submittedResultsRejected,\n"
    "      expiredAttemptsAbandoned,\n",
    'recovery return',
)

path.write_text(text)
