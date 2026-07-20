from pathlib import Path

path = Path('packages/runtime-core/src/commit/execution-commit-service.ts')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected one {label} match, found {count}')
    text = text.replace(old, new)


replace_once(
    "};\ntype Promotion = {\n",
    "};\ninterface CommitOptions {\n  allowExpiredLease?: boolean;\n}\ntype Promotion = {\n",
    'commit options type',
)

class_anchor = 'export class ExecutionCommitService {'
normalizer = """function normalizeSubmittedResult(value: Json): ProposedExecutionResult {
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
replace_once(class_anchor, normalizer + class_anchor, 'commit class anchor')

start = text.index('  async commitSubmittedResult(attemptId: string) {')
end = text.index('\n  async commit(', start)
replacement = """  async commitSubmittedResult(
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
text = text[:start] + replacement.rstrip('\n') + text[end:]

replace_once(
    "  async commit(\n"
    "    input: ProposedExecutionResult,\n"
    "    submissionDigest = canonicalJsonDigest(input),\n"
    "  ) {\n",
    "  async commit(\n"
    "    input: ProposedExecutionResult,\n"
    "    submissionDigest = canonicalJsonDigest(input),\n"
    "    options: CommitOptions = {},\n"
    "  ) {\n",
    'commit signature',
)

replace_once(
    "        if (submission && submission.submission_digest !== submissionDigest)\n"
    "          throw new ExecutionCommitError(\n"
    "            'duplicate_conflicting_result',\n"
    "            'attempt already has a different proposed result',\n"
    "          );\n"
    "        if (!['leased', 'running'].includes(attempt.status)) {\n"
    "          if (submission) return { disposition: 'duplicate' as const };\n",
    "        if (submission && submission.submission_digest !== submissionDigest)\n"
    "          throw new ExecutionCommitError(\n"
    "            'duplicate_conflicting_result',\n"
    "            'attempt already has a different proposed result',\n"
    "          );\n"
    "        if (submission?.committed_at)\n"
    "          return { disposition: 'duplicate' as const };\n"
    "        if (!['leased', 'running'].includes(attempt.status)) {\n",
    'terminal attempt handling',
)

replace_once(
    "        if (execution.status !== 'running') {\n"
    "          if (submission) return { disposition: 'duplicate' as const };\n"
    "          throw new ExecutionCommitError(\n",
    "        if (execution.status !== 'running') {\n"
    "          throw new ExecutionCommitError(\n",
    'terminal execution handling',
)

replace_once(
    '        this.assertAuthority(input, attempt, execution, region, deliveries);',
    "        this.assertAuthority(\n"
    "          input,\n"
    "          attempt,\n"
    "          execution,\n"
    "          region,\n"
    "          deliveries,\n"
    "          options.allowExpiredLease === true,\n"
    "        );",
    'authority invocation',
)

replace_once(
    "        if (input.status === 'completed')\n"
    "          return this.complete(\n"
    "            trx,\n"
    "            input,\n"
    "            execution,\n"
    "            component,\n"
    "            deliveries,\n"
    "            artifactIds,\n"
    "          );\n"
    "        return this.failOrRetry(trx, input, execution, attempt, deliveries);\n",
    "        const disposition =\n"
    "          input.status === 'completed'\n"
    "            ? await this.complete(\n"
    "                trx,\n"
    "                input,\n"
    "                execution,\n"
    "                component,\n"
    "                deliveries,\n"
    "                artifactIds,\n"
    "              )\n"
    "            : await this.failOrRetry(\n"
    "                trx,\n"
    "                input,\n"
    "                execution,\n"
    "                attempt,\n"
    "                deliveries,\n"
    "              );\n"
    "        await trx\n"
    "          .updateTable('worker_result_submissions')\n"
    "          .set({ committed_at: this.clock() })\n"
    "          .where('attempt_id', '=', input.attemptId)\n"
    "          .where('submission_digest', '=', submissionDigest)\n"
    "          .where('committed_at', 'is', null)\n"
    "          .executeTakeFirstOrThrow();\n"
    "        return disposition;\n",
    'commit outcome',
)

replace_once(
    "          .where('attempt_id', '=', input.attemptId)\n"
    "          .where('submission_digest', '=', submissionDigest)\n"
    "          .execute();\n",
    "          .where('attempt_id', '=', input.attemptId)\n"
    "          .where('submission_digest', '=', submissionDigest)\n"
    "          .where('committed_at', 'is', null)\n"
    "          .execute();\n",
    'pending submission cleanup',
)

replace_once(
    "  private assertAuthority(\n"
    "    input: ProposedExecutionResult,\n"
    "    attempt: any,\n"
    "    execution: any,\n"
    "    region: any,\n"
    "    deliveries: any[],\n"
    "  ) {\n",
    "  private assertAuthority(\n"
    "    input: ProposedExecutionResult,\n"
    "    attempt: any,\n"
    "    execution: any,\n"
    "    region: any,\n"
    "    deliveries: any[],\n"
    "    allowExpiredLease: boolean,\n"
    "  ) {\n",
    'authority signature',
)

replace_once(
    "    if (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock())\n"
    "      throw new ExecutionCommitError('lease_expired', 'lease has expired');\n",
    "    if (\n"
    "      !allowExpiredLease &&\n"
    "      (!attempt.lease_expires_at || attempt.lease_expires_at <= this.clock())\n"
    "    )\n"
    "      throw new ExecutionCommitError('lease_expired', 'lease has expired');\n",
    'lease expiry authority',
)

path.write_text(text)
