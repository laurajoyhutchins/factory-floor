from pathlib import Path

path = Path('packages/runtime-core/src/worker/worker-protocol-service.ts')
text = path.read_text()

old_options = (
    "export interface WorkerProtocolOptions {\n"
    "  leaseDurationMs: number;\n"
    "  baseUrl?: string;\n"
    "}\n"
)
new_options = (
    "export interface WorkerProtocolOptions {\n"
    "  leaseDurationMs: number;\n"
    "  baseUrl?: string;\n"
    "  afterResultHandoffCommitted?: (input: {\n"
    "    executionId: string;\n"
    "    attemptId: string;\n"
    "    submissionDigest: string;\n"
    "  }) => void | Promise<void>;\n"
    "}\n"
)
if text.count(old_options) != 1:
    raise SystemExit(f'expected one worker options match, found {text.count(old_options)}')
text = text.replace(old_options, new_options)

old_digest = "    const digest = canonicalJsonDigest(input);\n"
new_digest = (
    "    const commitInput = {\n"
    "      protocolVersion: input.protocolVersion,\n"
    "      executionId: attempt.executionId,\n"
    "      attemptId: attempt.attemptId,\n"
    "      leaseToken: attempt.leaseToken,\n"
    "      lifecycleEpoch: attempt.regionFencingEpoch,\n"
    "      status: input.status,\n"
    "      stagedArtifacts: stagedArtifacts.map(toWorkerV1StagedArtifact),\n"
    "      proposedEvents: input.proposedEvents,\n"
    "      externalActionProposals: input.externalActionProposals,\n"
    "      resourceUsage: input.resourceUsage,\n"
    "      ...(proposedState\n"
    "        ? { proposedState: toWorkerV1StagedArtifact(proposedState) }\n"
    "        : {}),\n"
    "      ...(input.failure === undefined ? {} : { failure: input.failure }),\n"
    "    };\n"
    "    const digest = canonicalJsonDigest(input);\n"
)
if text.count(old_digest) != 1:
    raise SystemExit(f'expected one digest anchor, found {text.count(old_digest)}')
text = text.replace(old_digest, new_digest)

old_result = "          result: input as unknown as Json,\n"
new_result = (
    "          result: commitInput as unknown as Json,\n"
    "          committed_at: null,\n"
)
if text.count(old_result) != 1:
    raise SystemExit(f'expected one handoff result match, found {text.count(old_result)}')
text = text.replace(old_result, new_result)

old_commit = (
    "    try {\n"
    "      const commitInput = {\n"
    "        protocolVersion: input.protocolVersion,\n"
    "        executionId: input.executionId,\n"
    "        attemptId: input.attemptId,\n"
    "        leaseToken: input.leaseToken,\n"
    "        lifecycleEpoch: attempt.regionFencingEpoch,\n"
    "        status: input.status,\n"
    "        stagedArtifacts: stagedArtifacts.map(toWorkerV1StagedArtifact),\n"
    "        proposedEvents: input.proposedEvents,\n"
    "        externalActionProposals: input.externalActionProposals,\n"
    "        resourceUsage: input.resourceUsage,\n"
    "        ...(proposedState\n"
    "          ? { proposedState: toWorkerV1StagedArtifact(proposedState) }\n"
    "          : {}),\n"
    "        ...(input.failure === undefined ? {} : { failure: input.failure }),\n"
    "      };\n"
    "      await new ExecutionCommitService(\n"
    "        this.db,\n"
    "        this.blobStore,\n"
    "        this.clock,\n"
    "      ).commit(\n"
    "        commitInput as unknown as Parameters<\n"
    "          ExecutionCommitService['commit']\n"
    "        >[0],\n"
    "      );\n"
)
new_commit = (
    "    await this.options.afterResultHandoffCommitted?.({\n"
    "      executionId: attempt.executionId,\n"
    "      attemptId: attempt.attemptId,\n"
    "      submissionDigest: digest,\n"
    "    });\n"
    "    try {\n"
    "      await new ExecutionCommitService(\n"
    "        this.db,\n"
    "        this.blobStore,\n"
    "        this.clock,\n"
    "      ).commitSubmittedResult(attempt.attemptId);\n"
)
if text.count(old_commit) != 1:
    raise SystemExit(f'expected one worker commit block, found {text.count(old_commit)}')
path.write_text(text.replace(old_commit, new_commit))
