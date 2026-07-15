export type ArtifactErrorCode =
  | 'staging_not_found' | 'staging_not_active' | 'schema_not_found' | 'unsupported_media_type'
  | 'artifact_too_large' | 'invalid_json' | 'schema_validation_failed' | 'digest_mismatch'
  | 'size_mismatch' | 'artifact_conflict' | 'committed_blob_conflict' | 'reconciliation_unresolved'
  | 'artifact_tombstoned';

export class ArtifactDomainError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string, readonly details?: unknown) {
    super(message); this.name = 'ArtifactDomainError';
  }
}
