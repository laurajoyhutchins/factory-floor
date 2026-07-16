import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  InvocationEnvelope,
  ProposedResult,
  StagedArtifact,
  WorkerCancellationResponse,
  WorkerCapabilityRequest,
  WorkerCapabilityResponse,
  WorkerClaimRequest,
  WorkerClaimResponse,
  WorkerError,
  WorkerHeartbeat,
  WorkerHeartbeatResponse,
  WorkerStageRequest,
  WorkerStageResponse,
  WorkerUploadResponse,
} from '@factory-floor/contracts-ts';

export const WORKER_PROTOCOL_VERSION = '1.0' as const;

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ResultIdentity =
  | 'protocolVersion'
  | 'executionId'
  | 'attemptId'
  | 'leaseToken'
  | 'lifecycleEpoch';
type ProposedResultBody = ProposedResult extends infer Result
  ? Result extends ProposedResult
    ? Omit<Result, ResultIdentity>
    : never
  : never;

export type BinaryContent = string | ArrayBuffer | ArrayBufferView | Blob;

export interface WorkerClientOptions {
  baseUrl: string;
  bearerToken: string;
  workerId: string;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  jitter?: (attempt: number) => number;
  maxRetryDelayMs?: number;
}

export type WorkerSdkErrorKind =
  | 'authentication'
  | 'invalid_request'
  | 'unsupported_protocol_version'
  | 'transient'
  | 'lease'
  | 'conflict'
  | 'capability_denied'
  | 'protocol'
  | 'network'
  | 'aborted';

export class WorkerSdkError extends Error {
  readonly kind: WorkerSdkErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: JsonRecord;

  constructor(
    message: string,
    options: {
      kind: WorkerSdkErrorKind;
      retryable: boolean;
      status?: number;
      code?: string;
      requestId?: string;
      details?: JsonRecord;
    },
  ) {
    super(redactSensitive(message));
    this.name = 'WorkerSdkError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

const sensitivePatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(leaseToken|capabilityHandle|uploadHandle|uploadUrl|signedUrl|token)=([^\s&]+)/gi,
  /(\/worker\/v1\/artifacts\/upload\/[^?\s]+)\?[^\s]+/gi,
];

export function redactSensitive(value: string): string {
  return sensitivePatterns.reduce(
    (text, pattern) =>
      text.replace(pattern, (_match, key: string | undefined) =>
        key ? `${key}=[REDACTED]` : '[REDACTED]',
      ),
    value,
  );
}

export interface WorkerResultSubmissionResponse {
  protocolVersion: '1.0';
  accepted: boolean;
  duplicate: boolean;
  handoff: string;
}

type RequestPayload =
  JsonRecord | WorkerHeartbeat | BodyInit | Readable | ArrayBufferView;

export class WorkerProtocolClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly workerId: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private readonly jitter: (attempt: number) => number;
  private readonly maxRetryDelayMs: number;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = new URL(
      options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.token = options.bearerToken;
    this.workerId = options.workerId;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? options.connectTimeoutMs ?? 10_000;
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.jitter = options.jitter ?? (() => 0);
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 2_000;
  }

  async claim(
    capabilities: string[],
    options: {
      signal?: AbortSignal;
      traceContext?: Record<string, string>;
      retries?: number;
    } = {},
  ): Promise<WorkerClaimResponse> {
    const body: WorkerClaimRequest = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.workerId,
      capabilities,
    };
    const response = await this.withRetry(
      () =>
        this.requestJson<WorkerClaimResponse>(
          'POST',
          'worker/v1/claim',
          body as unknown as JsonRecord,
          options,
        ),
      options.retries ?? 3,
      options.signal,
    );
    validateClaimResponse(response);
    return response;
  }

  async heartbeat(
    envelope: InvocationEnvelope,
    options: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<WorkerHeartbeatResponse> {
    return this.withRetry(
      () =>
        this.requestJson<WorkerHeartbeatResponse>(
          'POST',
          envelope.heartbeatUrl,
          leaseBody(envelope),
          options,
        ),
      options.retries ?? 2,
      options.signal,
    );
  }

  async observeCancellation(
    envelope: InvocationEnvelope,
    options: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<WorkerCancellationResponse> {
    return this.withRetry(
      () =>
        this.requestJson<WorkerCancellationResponse>(
          'POST',
          envelope.cancellationUrl,
          leaseBody(envelope),
          options,
        ),
      options.retries ?? 2,
      options.signal,
    );
  }

  async stageArtifact(
    envelope: InvocationEnvelope,
    request: Omit<WorkerStageRequest, ResultIdentity>,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkerStageResponse> {
    return this.requestJson<WorkerStageResponse>(
      'POST',
      envelope.artifactStagingUrl,
      { ...leaseBody(envelope), ...request },
      options,
    );
  }

  async uploadStagedContent(
    uploadUrl: string,
    content: BodyInit | Readable | ArrayBufferView,
    options: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<WorkerUploadResponse> {
    const retries = isOneShotBody(content) ? 0 : (options.retries ?? 1);
    return this.withRetry(
      () =>
        this.requestJson<WorkerUploadResponse>('PUT', uploadUrl, content, {
          ...options,
          contentType: 'application/octet-stream',
        }),
      retries,
      options.signal,
    );
  }

  async submitResult(
    result: ProposedResult,
    url: string,
    options: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<WorkerResultSubmissionResponse> {
    return this.withRetry(
      () =>
        this.requestJson<WorkerResultSubmissionResponse>(
          'POST',
          url,
          result as unknown as JsonRecord,
          options,
        ),
      options.retries ?? 2,
      options.signal,
    );
  }

  async invokeCapability(
    envelope: InvocationEnvelope,
    handle: string,
    input: JsonRecord,
    options: { signal?: AbortSignal; retry?: boolean } = {},
  ): Promise<WorkerCapabilityResponse> {
    const body: WorkerCapabilityRequest = {
      ...leaseBody(envelope),
      handle,
      input,
    };
    const invoke = () =>
      this.requestJson<WorkerCapabilityResponse>(
        'POST',
        envelope.capabilityInvocationUrl,
        body as unknown as JsonRecord,
        options,
      );
    return options.retry === true
      ? this.withRetry(invoke, 1, options.signal)
      : invoke();
  }

  private async requestJson<T>(
    method: string,
    pathOrUrl: string,
    body: RequestPayload,
    options: {
      signal?: AbortSignal;
      traceContext?: Record<string, string>;
      contentType?: string;
    } = {},
  ): Promise<T> {
    const url = absoluteUrl(this.baseUrl, pathOrUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const signal = anySignal([controller.signal, options.signal]);
    const isJson = options.contentType !== 'application/octet-stream';
    const headers = new Headers({
      Authorization: `Bearer ${this.token}`,
      'x-worker-id': this.workerId,
      'content-type': isJson ? 'application/json' : 'application/octet-stream',
    });
    for (const [key, value] of Object.entries(options.traceContext ?? {}))
      headers.set(key, value);

    try {
      const requestBody = isJson
        ? JSON.stringify(body)
        : normalizeFetchBody(body);
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        body: requestBody,
        signal,
      };
      if (!isJson && isOneShotBody(body)) init.duplex = 'half';
      const response = await this.fetchImpl(url.toString(), init);
      const payload = await parsePayload(response);
      if (!response.ok) throw mapError(response.status, payload);
      validateProtocol(payload);
      return payload as T;
    } catch (error) {
      if (error instanceof WorkerSdkError) throw error;
      if ((error as { name?: string }).name === 'AbortError')
        throw new WorkerSdkError('worker protocol request aborted', {
          kind: options.signal?.aborted ? 'aborted' : 'network',
          retryable: !options.signal?.aborted,
        });
      throw new WorkerSdkError(
        redactSensitive(String((error as Error).message ?? error)),
        { kind: 'network', retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    retries: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof WorkerSdkError) ||
          !error.retryable ||
          attempt >= retries ||
          signal?.aborted
        )
          throw error;
        const delay =
          Math.min(this.maxRetryDelayMs, 50 * 2 ** attempt) +
          this.jitter(attempt);
        await this.sleepImpl(delay, signal);
        attempt += 1;
      }
    }
  }
}

function leaseBody(envelope: InvocationEnvelope): WorkerHeartbeat {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    executionId: envelope.executionId,
    attemptId: envelope.attemptId,
    leaseToken: envelope.leaseToken,
    lifecycleEpoch: envelope.lifecycleEpoch,
  };
}

function absoluteUrl(baseUrl: URL, pathOrUrl: string): URL {
  try {
    return new URL(pathOrUrl);
  } catch {
    return new URL(pathOrUrl.replace(/^\//, ''), baseUrl);
  }
}

function normalizeFetchBody(body: RequestPayload): BodyInit {
  if (ArrayBuffer.isView(body)) {
    const source = new Uint8Array(
      body.buffer,
      body.byteOffset,
      body.byteLength,
    );
    const owned: Uint8Array<ArrayBuffer> = new Uint8Array(source.byteLength);
    owned.set(source);
    return owned;
  }
  return body as BodyInit;
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerSdkError('worker protocol returned non-json response', {
      kind: 'protocol',
      retryable: response.status >= 500,
      status: response.status,
    });
  }
}

function validateProtocol(payload: unknown): void {
  if (!isRecord(payload) || payload.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw new WorkerSdkError('unsupported worker protocol version', {
      kind: 'unsupported_protocol_version',
      retryable: false,
    });
}

function validateClaimResponse(response: WorkerClaimResponse): void {
  if (response.claimed) {
    parseInvocationEnvelope(response.envelope);
    return;
  }
  if (!Number.isInteger(response.retryAfterMs) || response.retryAfterMs < 0)
    throw new WorkerSdkError('invalid worker no-work response', {
      kind: 'protocol',
      retryable: false,
    });
}

export function parseInvocationEnvelope(value: unknown): InvocationEnvelope {
  if (!isRecord(value))
    throw invalidEnvelope('invocation envelope must be an object');
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw invalidEnvelope('protocolVersion must be 1.0');
  requireString(value.executionId, 'executionId');
  requireString(value.attemptId, 'attemptId');
  requirePositiveInteger(value.attemptNumber, 'attemptNumber');
  requireString(value.leaseToken, 'leaseToken');
  requireTimestamp(value.leaseExpiresAt, 'leaseExpiresAt');
  requireNonNegativeInteger(value.lifecycleEpoch, 'lifecycleEpoch');
  if (!isRecord(value.component))
    throw invalidEnvelope('component must be an object');
  requireString(value.component.definitionName, 'component.definitionName');
  requireString(
    value.component.definitionVersion,
    'component.definitionVersion',
  );
  if (!Array.isArray(value.inputs))
    throw invalidEnvelope('inputs must be an array');
  for (const field of [
    'cancellationUrl',
    'heartbeatUrl',
    'resultSubmissionUrl',
    'artifactStagingUrl',
    'capabilityInvocationUrl',
  ] as const)
    requireString(value[field], field);
  if (!isRecord(value.limits))
    throw invalidEnvelope('limits must be an object');
  requirePositiveInteger(
    value.limits.heartbeatIntervalMs,
    'limits.heartbeatIntervalMs',
  );
  return value as unknown as InvocationEnvelope;
}

function invalidEnvelope(message: string): WorkerSdkError {
  return new WorkerSdkError(`invalid invocation envelope: ${message}`, {
    kind: 'protocol',
    retryable: false,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw invalidEnvelope(`${field} must be a non-empty string`);
}

function requireTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  requireString(value, field);
  if (!Number.isFinite(Date.parse(value)))
    throw invalidEnvelope(`${field} must be a timestamp`);
}

function requirePositiveInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0)
    throw invalidEnvelope(`${field} must be a positive integer`);
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw invalidEnvelope(`${field} must be a non-negative integer`);
}

function mapError(status: number, payload: unknown): WorkerSdkError {
  const error = payload as Partial<WorkerError>;
  const code = typeof error.code === 'string' ? error.code : 'unknown_error';
  const kind: WorkerSdkErrorKind = code.includes('auth')
    ? 'authentication'
    : code.includes('version')
      ? 'unsupported_protocol_version'
      : code.includes('lease') ||
          code.includes('inactive') ||
          code.includes('stale')
        ? 'lease'
        : code.includes('conflicting')
          ? 'conflict'
          : code.includes('capability')
            ? 'capability_denied'
            : status >= 500
              ? 'transient'
              : 'invalid_request';
  return new WorkerSdkError(
    error.message ?? `worker protocol error ${status}`,
    {
      kind,
      retryable: error.retryable ?? status >= 500,
      status,
      code,
      requestId: error.requestId,
      details: error.details,
    },
  );
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new WorkerSdkError('sleep aborted', {
          kind: 'aborted',
          retryable: false,
        }),
      );
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(
          new WorkerSdkError('sleep aborted', {
            kind: 'aborted',
            retryable: false,
          }),
        );
      },
      { once: true },
    );
  });
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }
  return controller.signal;
}

function isOneShotBody(value: unknown): boolean {
  return (
    value instanceof Readable ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { getReader?: unknown }).getReader === 'function')
  );
}

export interface WorkerExecutionContext {
  envelope: InvocationEnvelope;
  client: WorkerProtocolClient;
  signal: AbortSignal;
  log: (event: string, fields?: JsonRecord) => void;
  stageJson: (
    portName: string,
    value: unknown,
    metadata: JsonRecord,
  ) => Promise<StagedArtifact>;
  stageBinary: (
    portName: string,
    content: BinaryContent,
    mediaType: string,
    metadata: JsonRecord,
  ) => Promise<StagedArtifact>;
  invokeCapability: (
    handle: string,
    input: JsonRecord,
    options?: { retry?: boolean },
  ) => Promise<WorkerCapabilityResponse>;
}

export type WorkerComponent = (
  context: WorkerExecutionContext,
) => Promise<ProposedResult | ProposedResultBody>;

export class ComponentRegistry {
  private readonly components = new Map<string, WorkerComponent>();

  register(name: string, version: string, component: WorkerComponent): void {
    this.components.set(`${name}@${version}`, component);
  }

  get(name: string, version: string): WorkerComponent | undefined {
    return this.components.get(`${name}@${version}`);
  }

  capabilities(): string[] {
    return [...this.components.keys()].sort();
  }
}

export interface WorkerRunnerOptions {
  client: WorkerProtocolClient;
  registry: ComponentRegistry;
  concurrency?: number;
  pollDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  logger?: (event: string, fields?: JsonRecord) => void;
}

export class WorkerRunner {
  private readonly options: Required<WorkerRunnerOptions>;
  private stopping = false;

  constructor(options: WorkerRunnerOptions) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new RangeError('worker concurrency must be a positive integer');
    this.options = {
      concurrency,
      pollDelayMs: 500,
      sleep: defaultSleep,
      logger: () => undefined,
      ...options,
    };
  }

  async run(signal?: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    let nextPollDelay = this.options.pollDelayMs;

    while (!this.stopping && !signal?.aborted) {
      while (active.size < this.options.concurrency) {
        const claim = await this.options.client
          .claim(this.options.registry.capabilities(), { signal })
          .catch((error) => {
            this.options.logger('claim_failed', {
              error: redactSensitive(String(error)),
            });
            return undefined;
          });
        if (!claim) break;
        if (!claim.claimed) {
          nextPollDelay = claim.retryAfterMs;
          break;
        }
        const envelope = parseInvocationEnvelope(claim.envelope);
        const task = this.execute(envelope, signal).finally(() =>
          active.delete(task),
        );
        active.add(task);
        nextPollDelay = this.options.pollDelayMs;
      }

      if (active.size === 0)
        await this.options.sleep(nextPollDelay, signal).catch(() => undefined);
      else
        await Promise.race([
          Promise.race(active),
          this.options.sleep(nextPollDelay, signal),
        ]).catch(() => undefined);
      nextPollDelay = this.options.pollDelayMs;
    }

    await Promise.allSettled(active);
  }

  stop(): void {
    this.stopping = true;
  }

  installSignalHandlers(): void {
    for (const systemSignal of ['SIGINT', 'SIGTERM'] as const)
      process.once(systemSignal, () => this.stop());
  }

  private async execute(
    envelope: InvocationEnvelope,
    outerSignal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (outerSignal?.aborted) abort();
    else outerSignal?.addEventListener('abort', abort, { once: true });
    const heartbeat = this.heartbeatLoop(envelope, controller);
    const component = this.options.registry.get(
      envelope.component.definitionName,
      envelope.component.definitionVersion,
    );

    try {
      if (!component)
        throw new WorkerSdkError('component implementation not registered', {
          kind: 'protocol',
          retryable: false,
        });

      let partial: ProposedResult | ProposedResultBody;
      try {
        partial = await component(this.context(envelope, controller.signal));
      } catch (error) {
        await this.submitComponentFailure(envelope, controller, error);
        return;
      }

      if (controller.signal.aborted) return;
      const cancellation = await this.options.client.observeCancellation(
        envelope,
        { signal: controller.signal },
      );
      if (cancellation.state !== 'continue') {
        controller.abort();
        this.options.logger('submission_fenced', {
          executionId: envelope.executionId,
          state: cancellation.state,
        });
        return;
      }

      await this.options.client.submitResult(
        normalizeResultIdentity(envelope, partial),
        envelope.resultSubmissionUrl,
        { signal: controller.signal },
      );
    } catch (error) {
      this.options.logger('execution_failed', {
        executionId: envelope.executionId,
        error: redactSensitive(String((error as Error).message ?? error)),
      });
    } finally {
      controller.abort();
      await heartbeat;
      outerSignal?.removeEventListener('abort', abort);
    }
  }

  private async submitComponentFailure(
    envelope: InvocationEnvelope,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    this.options.logger('component_failed', {
      executionId: envelope.executionId,
      error: redactSensitive(String((error as Error).message ?? error)),
    });
    if (controller.signal.aborted) return;

    try {
      const cancellation = await this.options.client.observeCancellation(
        envelope,
        { signal: controller.signal },
      );
      if (cancellation.state !== 'continue') {
        controller.abort();
        return;
      }
      await this.options.client.submitResult(
        componentFailureResult(envelope),
        envelope.resultSubmissionUrl,
        { signal: controller.signal },
      );
    } catch (submissionError) {
      this.options.logger('failure_submission_failed', {
        executionId: envelope.executionId,
        error: redactSensitive(
          String((submissionError as Error).message ?? submissionError),
        ),
      });
    }
  }

  private async heartbeatLoop(
    envelope: InvocationEnvelope,
    controller: AbortController,
  ): Promise<void> {
    let expiresAt = Date.parse(envelope.leaseExpiresAt);
    while (!controller.signal.aborted) {
      const delay = Math.max(1, Math.floor((expiresAt - Date.now()) / 2));
      await this.options.sleep(delay, controller.signal).catch(() => undefined);
      if (controller.signal.aborted) break;

      try {
        const response = await this.options.client.heartbeat(envelope, {
          signal: controller.signal,
        });
        if (
          !response.leaseValid ||
          response.cancellation === 'cancellation_requested'
        ) {
          controller.abort();
          break;
        }
        expiresAt = Date.parse(response.leaseExpiresAt);
      } catch (error) {
        this.options.logger('heartbeat_failed', {
          executionId: envelope.executionId,
          error: redactSensitive(String((error as Error).message ?? error)),
        });
        controller.abort();
        break;
      }
    }
  }

  private context(
    envelope: InvocationEnvelope,
    signal: AbortSignal,
  ): WorkerExecutionContext {
    const stageBinary = async (
      portName: string,
      content: BinaryContent,
      mediaType: string,
      metadata: JsonRecord,
    ): Promise<StagedArtifact> => {
      const bytes = await binaryContentBytes(content);
      const schemaId = metadata.schemaId;
      const schemaDigest = metadata.schemaDigest;
      if (typeof schemaId !== 'string' || schemaId.length === 0)
        throw new WorkerSdkError('artifact schemaId is required', {
          kind: 'invalid_request',
          retryable: false,
        });
      if (
        typeof schemaDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(schemaDigest)
      )
        throw new WorkerSdkError(
          'artifact schemaDigest must be a lowercase SHA-256 digest',
          { kind: 'invalid_request', retryable: false },
        );

      const digest = createHash('sha256').update(bytes).digest('hex');
      const stage = await this.options.client.stageArtifact(
        envelope,
        {
          portName,
          mediaType,
          expectedDigest: digest,
          expectedSizeBytes: bytes.byteLength,
          metadata,
        },
        { signal },
      );
      const uploaded = await this.options.client.uploadStagedContent(
        stage.uploadUrl,
        bytes,
        { signal },
      );
      return {
        stagingId: uploaded.stagedRef,
        portName,
        digest: uploaded.digest,
        sizeBytes: uploaded.sizeBytes,
        mediaType,
        schemaId,
        schemaDigest,
        provenance: {
          kind: 'execution',
          executionId: envelope.executionId,
          attemptId: envelope.attemptId,
        },
      };
    };

    return {
      envelope,
      client: this.options.client,
      signal,
      log: this.options.logger,
      stageBinary,
      stageJson: (portName, value, metadata) =>
        stageBinary(
          portName,
          canonicalJson(value),
          'application/json',
          metadata,
        ),
      invokeCapability: (handle, input, options) =>
        this.options.client.invokeCapability(envelope, handle, input, {
          signal,
          ...options,
        }),
    };
  }
}

function normalizeResultIdentity(
  envelope: InvocationEnvelope,
  result: ProposedResult | ProposedResultBody,
): ProposedResult {
  return {
    ...result,
    ...leaseBody(envelope),
  } as ProposedResult;
}

function componentFailureResult(envelope: InvocationEnvelope): ProposedResult {
  return {
    ...leaseBody(envelope),
    status: 'failed',
    stagedArtifacts: [],
    proposedEvents: [],
    externalActionProposals: [],
    resourceUsage: emptyResourceUsage(),
    failure: {
      code: 'WORKER_COMPONENT_ERROR',
      message: 'Worker component execution failed.',
      category: 'unknown',
      retryable: true,
      details: {
        component: `${envelope.component.definitionName}@${envelope.component.definitionVersion}`,
      },
    },
  };
}

async function binaryContentBytes(
  content: BinaryContent,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    const source = new Uint8Array(
      content.buffer,
      content.byteOffset,
      content.byteLength,
    );
    const owned: Uint8Array<ArrayBuffer> = new Uint8Array(source.byteLength);
    owned.set(source);
    return owned;
  }
  if (content instanceof Blob)
    return new Uint8Array(await content.arrayBuffer());
  throw new WorkerSdkError('unsupported binary artifact body', {
    kind: 'invalid_request',
    retryable: false,
  });
}

export function canonicalJson(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('non-finite numbers are not canonical JSON');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function emptyResourceUsage() {
  return {
    cpuMilliseconds: 0,
    wallMilliseconds: 0,
    inputBytes: 0,
    outputBytes: 0,
    externalCalls: 0,
  };
}
