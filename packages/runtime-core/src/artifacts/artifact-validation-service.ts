import { createHash } from 'node:crypto';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ArtifactBlobStore } from '@factory-floor/artifact-store';
import type { ArtifactRepository } from '@factory-floor/db';
import type { RuntimeDb } from '@factory-floor/db';
import { ArtifactDomainError } from './errors.js';

const VALIDATION_RECEIPT_LIMIT = 1_024;
const COMPILED_VALIDATOR_LIMIT = 1_024;
const validationReceipts = new Map<string, string>();
const compiledValidators = new Map<string, ValidateFunction>();

export function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json');
}

function rememberReceipt(stagingRowId: string, fingerprint: string) {
  validationReceipts.delete(stagingRowId);
  validationReceipts.set(stagingRowId, fingerprint);
  while (validationReceipts.size > VALIDATION_RECEIPT_LIMIT) {
    const oldest = validationReceipts.keys().next().value as string | undefined;
    if (!oldest) break;
    validationReceipts.delete(oldest);
  }
}

function compiledValidator(
  schemaDigest: string,
  schema: object,
): ValidateFunction {
  const existing = compiledValidators.get(schemaDigest);
  if (existing) {
    compiledValidators.delete(schemaDigest);
    compiledValidators.set(schemaDigest, existing);
    return existing;
  }
  const Ajv2020 = Ajv2020Import.default ?? Ajv2020Import;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  compiledValidators.set(schemaDigest, validate);
  while (compiledValidators.size > COMPILED_VALIDATOR_LIMIT) {
    const oldest = compiledValidators.keys().next().value as string | undefined;
    if (!oldest) break;
    compiledValidators.delete(oldest);
  }
  return validate;
}

export class ArtifactValidationService {
  constructor(
    private readonly deps: {
      db: RuntimeDb;
      repository: ArtifactRepository;
      blobStore: ArtifactBlobStore;
      maxJsonBytes: bigint;
    },
  ) {}

  async validateStagedArtifact(stagingRowId: string) {
    const row = await this.deps.repository.readStagingById(
      this.deps.db,
      stagingRowId,
    );
    if (!row)
      throw new ArtifactDomainError(
        'staging_not_found',
        'staging row was not found',
      );
    if (row.status !== 'staged')
      throw new ArtifactDomainError(
        'staging_not_active',
        'staging row is not active',
      );
    const schema = await this.deps.repository.readArtifactSchemaById(
      this.deps.db,
      row.schema_id,
    );
    if (!schema || schema.retired_at)
      throw new ArtifactDomainError(
        'schema_not_found',
        'artifact schema was not found or is retired',
      );
    if (!isJsonMediaType(row.media_type))
      throw new ArtifactDomainError(
        'unsupported_media_type',
        'artifact media type is not JSON',
      );

    const fingerprint = [
      row.id,
      row.staged_ref,
      row.digest,
      row.size_bytes,
      row.schema_id,
      row.media_type,
      schema.content_digest,
    ].join(':');
    if (validationReceipts.get(row.id) === fingerprint)
      return { row, schema, instance: undefined, cached: true as const };

    const stream = await this.deps.blobStore.readStaged(row.staged_ref);
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let size = 0n;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      size += BigInt(bytes.length);
      if (size > this.deps.maxJsonBytes)
        throw new ArtifactDomainError(
          'artifact_too_large',
          'artifact exceeds maximum JSON validation size',
        );
      hash.update(bytes);
      chunks.push(bytes);
    }
    const digest = hash.digest('hex');
    if (digest !== row.digest)
      throw new ArtifactDomainError(
        'digest_mismatch',
        'staged bytes digest does not match database metadata',
      );
    if (size.toString() !== row.size_bytes)
      throw new ArtifactDomainError(
        'size_mismatch',
        'staged bytes size does not match database metadata',
      );
    let instance: unknown;
    try {
      instance = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ArtifactDomainError(
        'invalid_json',
        'artifact is not valid JSON',
      );
    }
    const validate = compiledValidator(
      schema.content_digest,
      schema.schema as object,
    );
    if (!validate(instance))
      throw new ArtifactDomainError(
        'schema_validation_failed',
        'artifact failed schema validation',
        validate.errors?.map((error: ErrorObject) => ({
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          message: error.message,
        })),
      );
    rememberReceipt(row.id, fingerprint);
    return { row, schema, instance, cached: false as const };
  }
}
