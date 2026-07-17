export interface OperatorPrincipal {
  id: string;
  roles: readonly string[];
}

export interface OperatorContext {
  principal: OperatorPrincipal;
  adapter?: string;
}

export interface DevelopmentTaskRequest {
  clientRequestId: string;
  repository: string;
  objective: string;
  acceptanceCriteria: string[];
  authority?: {
    mayCreateBranch?: boolean;
    mayOpenDraftPullRequest?: boolean;
    mayMerge?: boolean;
  };
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ApprovalDecisionRequest {
  clientRequestId: string;
  decision: 'approve' | 'reject';
  reason: string;
}

export interface RunCancellationRequest {
  clientRequestId: string;
  reason: string;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}
