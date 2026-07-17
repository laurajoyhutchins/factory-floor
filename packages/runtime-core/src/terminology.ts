export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ComponentSelector = Brand<string, 'ComponentSelector'>;
export type WorkerId = Brand<string, 'WorkerId'>;
export type LeaseToken = Brand<string, 'LeaseToken'>;
export type StagingRef = Brand<string, 'StagingRef'>;
export type RegionFencingEpoch = Brand<number, 'RegionFencingEpoch'>;

export type RegionLifecycleState =
  | 'declared'
  | 'starting'
  | 'ready'
  | 'running'
  | 'completing'
  | 'completed'
  | 'blocked'
  | 'suspended'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
export type ComponentInstanceLifecycleState =
  'declared' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed';
export type CommandState =
  'accepted' | 'rejected' | 'completed' | 'cancelled' | 'expired';
export type DeliveryState =
  'ready' | 'leased' | 'completed' | 'failed' | 'dead_lettered' | 'cancelled';
export type ExecutionState =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionAttemptState =
  | 'pending'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned';
export type ArtifactState = 'staged' | 'committed' | 'tombstoned';
export type ArtifactStagingState = 'staged' | 'promoted' | 'abandoned';
export type CapabilityGrantState = 'active' | 'revoked';
export type ApprovalState = 'requested' | 'approved' | 'denied' | 'cancelled';
export type ExternalActionState =
  | 'proposed'
  | 'policy_checked'
  | 'awaiting_approval'
  | 'authorized'
  | 'dispatching'
  | 'acknowledged'
  | 'reconciled'
  | 'denied'
  | 'failed'
  | 'cancelled'
  | 'indeterminate';
export type ExternalActionAttemptState =
  'pending' | 'dispatching' | 'acknowledged' | 'failed' | 'indeterminate';

export function normalizeComponentSelectors(
  input: readonly string[],
): ComponentSelector[] {
  return [
    ...new Set(input.map((v) => v.trim()).filter(Boolean)),
  ] as ComponentSelector[];
}
