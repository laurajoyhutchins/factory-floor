import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
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

export interface WorkerClientOptions {
  baseUrl: string;
  bearerToken: string;
  workerId: string;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

  constructor(message: string, options: { kind: WorkerSdkErrorKind; retryable: boolean; status?: number; code?: string; requestId?: string; details?: JsonRecord }) {
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
  return sensitivePatterns.reduce((text, pattern) => text.replace(pattern, (_match, key) => (key ? `${key}=[REDACTED]` : '[REDACTED]')), value);
}

export class WorkerProtocolClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly workerId: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly jitter: (attempt: number) => number;
  private readonly maxRetryDelayMs: number;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    this.token = options.bearerToken;
    this.workerId = options.workerId;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.connectTimeoutMs ?? 10_000;
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.jitter = options.jitter ?? (() => 0);
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 2_000;
  }

  async claim(capabilities: string[], options: { signal?: AbortSignal; traceContext?: Record<string, string>; retries?: number } = {}): Promise<WorkerClaimResponse> {
    const body: WorkerClaimRequest = { protocolVersion: WORKER_PROTOCOL_VERSION, workerId: this.workerId, capabilities };
    return this.withRetry(() => this.requestJson<WorkerClaimResponse>('POST', 'worker/v1/claim', body as unknown as JsonRecord, options), options.retries ?? 3, options.signal);
  }

  async heartbeat(envelope: InvocationEnvelope, options: { signal?: AbortSignal; retries?: number } = {}): Promise<WorkerHeartbeatResponse> {
    const body = leaseBody(envelope) satisfies WorkerHeartbeat;
    return this.withRetry(() => this.requestJson<WorkerHeartbeatResponse>('POST', envelope.heartbeatUrl, body, options), options.retries ?? 2, options.signal);
  }

  async observeCancellation(envelope: InvocationEnvelope, options: { signal?: AbortSignal; retries?: number } = {}): Promise<WorkerCancellationResponse> {
    return this.withRetry(() => this.requestJson<WorkerCancellationResponse>('POST', envelope.cancellationUrl, leaseBody(envelope), options), options.retries ?? 2, options.signal);
  }

  async stageArtifact(envelope: InvocationEnvelope, request: Omit<WorkerStageRequest, 'protocolVersion' | 'executionId' | 'attemptId' | 'leaseToken' | 'lifecycleEpoch'>, options: { signal?: AbortSignal } = {}): Promise<WorkerStageResponse> {
    return this.requestJson<WorkerStageResponse>('POST', envelope.artifactStagingUrl, { ...leaseBody(envelope), ...request }, options);
  }

  async uploadStagedContent(uploadUrl: string, content: BodyInit | Readable, options: { signal?: AbortSignal; retries?: number } = {}): Promise<WorkerUploadResponse> {
    return this.withRetry(() => this.requestJson<WorkerUploadResponse>('PUT', uploadUrl, content as BodyInit, { ...options, contentType: 'application/octet-stream' }), options.retries ?? 1, options.signal);
  }

  async submitResult(result: ProposedResult, url: string, options: { signal?: AbortSignal; retries?: number } = {}): Promise<{ protocolVersion: '1.0'; accepted: boolean; duplicate: boolean; handoff: JsonRecord }> {
    return this.withRetry(() => this.requestJson('POST', url, result, options), options.retries ?? 2, options.signal);
  }

  async invokeCapability(envelope: InvocationEnvelope, handle: string, input: JsonRecord, options: { signal?: AbortSignal; retry?: boolean } = {}): Promise<WorkerCapabilityResponse> {
    const body: WorkerCapabilityRequest = { ...leaseBody(envelope), handle, input };
    return options.retry === true
      ? this.withRetry(() => this.requestJson<WorkerCapabilityResponse>('POST', envelope.capabilityInvocationUrl, body as unknown as JsonRecord, options), 1, options.signal)
      : this.requestJson<WorkerCapabilityResponse>('POST', envelope.capabilityInvocationUrl, body as unknown as JsonRecord, options);
  }

  private async requestJson<T>(method: string, pathOrUrl: string, body: BodyInit | JsonRecord, options: { signal?: AbortSignal; traceContext?: Record<string, string>; contentType?: string } = {}): Promise<T> {
    const url = absoluteUrl(this.baseUrl, pathOrUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const signal = anySignal([controller.signal, options.signal]);
    const isJson = options.contentType !== 'application/octet-stream';
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, 'x-worker-id': this.workerId });
    if (isJson) headers.set('content-type', 'application/json');
    else headers.set('content-type', 'application/octet-stream');
    for (const [key, value] of Object.entries(options.traceContext ?? {})) headers.set(key, value);
    try {
      const response = await this.fetchImpl(url.toString(), { method, headers, body: isJson ? JSON.stringify(body) : (body as BodyInit), signal, duplex: !isJson ? 'half' : undefined } as RequestInit);
      const payload = await parsePayload(response);
      if (!response.ok) throw mapError(response.status, payload);
      validateProtocol(payload);
      return payload as T;
    } catch (error) {
      if (error instanceof WorkerSdkError) throw error;
      if ((error as { name?: string }).name === 'AbortError') throw new WorkerSdkError('worker protocol request aborted', { kind: options.signal?.aborted ? 'aborted' : 'network', retryable: !options.signal?.aborted });
      throw new WorkerSdkError(redactSensitive(String((error as Error).message ?? error)), { kind: 'network', retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withRetry<T>(operation: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof WorkerSdkError) || !error.retryable || attempt >= retries || signal?.aborted) throw error;
        const delay = Math.min(this.maxRetryDelayMs, 50 * 2 ** attempt) + this.jitter(attempt);
        await this.sleepImpl(delay, signal);
        attempt += 1;
      }
    }
  }
}

function leaseBody(envelope: InvocationEnvelope) {
  return { protocolVersion: WORKER_PROTOCOL_VERSION, executionId: envelope.executionId, attemptId: envelope.attemptId, leaseToken: envelope.leaseToken, lifecycleEpoch: envelope.lifecycleEpoch } as const;
}

function absoluteUrl(baseUrl: URL, pathOrUrl: string): URL {
  try { return new URL(pathOrUrl); } catch { return new URL(pathOrUrl.replace(/^\//, ''), baseUrl); }
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try { return JSON.parse(text); } catch { throw new WorkerSdkError('worker protocol returned non-json response', { kind: 'protocol', retryable: response.status >= 500, status: response.status }); }
}

function validateProtocol(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || (payload as { protocolVersion?: unknown }).protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new WorkerSdkError('unsupported worker protocol version', { kind: 'unsupported_protocol_version', retryable: false });
  }
}

function mapError(status: number, payload: unknown): WorkerSdkError {
  const err = payload as Partial<WorkerError>;
  const code = typeof err.code === 'string' ? err.code : 'unknown_error';
  const kind: WorkerSdkErrorKind = code.includes('auth') ? 'authentication' : code.includes('version') ? 'unsupported_protocol_version' : code.includes('lease') || code.includes('inactive') || code.includes('stale') ? 'lease' : code.includes('conflicting') ? 'conflict' : code.includes('capability') ? 'capability_denied' : status >= 500 ? 'transient' : 'invalid_request';
  return new WorkerSdkError(err.message ?? `worker protocol error ${status}`, { kind, retryable: err.retryable ?? status >= 500, status, code, requestId: err.requestId, details: err.details });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(new WorkerSdkError('sleep aborted', { kind: 'aborted', retryable: false })); }, { once: true });
  });
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export interface WorkerExecutionContext {
  envelope: InvocationEnvelope;
  client: WorkerProtocolClient;
  signal: AbortSignal;
  log: (event: string, fields?: JsonRecord) => void;
  stageJson: (portName: string, value: unknown, metadata?: JsonRecord) => Promise<StagedArtifact>;
  stageBinary: (portName: string, content: BodyInit, mediaType: string, metadata?: JsonRecord) => Promise<StagedArtifact>;
  invokeCapability: (handle: string, input: JsonRecord, options?: { retry?: boolean }) => Promise<WorkerCapabilityResponse>;
}
export type WorkerComponent = (context: WorkerExecutionContext) => Promise<ProposedResult | Omit<ProposedResult, 'protocolVersion' | 'executionId' | 'attemptId' | 'leaseToken' | 'lifecycleEpoch'>>;
export class ComponentRegistry {
  private readonly components = new Map<string, WorkerComponent>();
  register(name: string, version: string, component: WorkerComponent): void { this.components.set(`${name}@${version}`, component); }
  get(name: string, version: string): WorkerComponent | undefined { return this.components.get(`${name}@${version}`); }
  capabilities(): string[] { return [...this.components.keys()].sort(); }
}

export interface WorkerRunnerOptions { client: WorkerProtocolClient; registry: ComponentRegistry; concurrency?: number; pollDelayMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; logger?: (event: string, fields?: JsonRecord) => void; }
export class WorkerRunner {
  private readonly options: Required<WorkerRunnerOptions>;
  private stopping = false;
  constructor(options: WorkerRunnerOptions) { this.options = { concurrency: 1, pollDelayMs: 500, sleep: defaultSleep, logger: () => undefined, ...options }; }
  async run(signal?: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    while (!this.stopping && !signal?.aborted) {
      while (active.size < this.options.concurrency) {
        const claim = await this.options.client.claim(this.options.registry.capabilities(), { signal }).catch((error) => { this.options.logger('claim_failed', { error: String(error) }); return undefined; });
        if (!claim || !claim.claimed) break;
        const task = this.execute(claim.envelope as InvocationEnvelope, signal).finally(() => active.delete(task));
        active.add(task);
      }
      if (active.size === 0) await this.options.sleep(this.options.pollDelayMs, signal).catch(() => undefined);
      else await Promise.race([Promise.race(active), this.options.sleep(this.options.pollDelayMs, signal)]).catch(() => undefined);
    }
    await Promise.allSettled(active);
  }
  stop(): void { this.stopping = true; }
  installSignalHandlers(): void { for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => this.stop()); }
  private async execute(envelope: InvocationEnvelope, outerSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    outerSignal?.addEventListener('abort', () => controller.abort(), { once: true });
    const heartbeat = this.heartbeatLoop(envelope, controller);
    const component = this.options.registry.get(envelope.component.definitionName, envelope.component.definitionVersion);
    try {
      if (!component) throw new WorkerSdkError('component implementation not registered', { kind: 'protocol', retryable: false });
      const context = this.context(envelope, controller.signal);
      const partial = await component(context);
      const cancellation = await this.options.client.observeCancellation(envelope, { signal: controller.signal });
      if (cancellation.state !== 'continue') throw new WorkerSdkError(`submission fenced by ${cancellation.state}`, { kind: 'lease', retryable: false });
      await this.options.client.submitResult({ ...leaseBody(envelope), ...partial } as ProposedResult, envelope.resultSubmissionUrl, { signal: controller.signal });
    } catch (error) { this.options.logger('execution_failed', { executionId: envelope.executionId, error: redactSensitive(String((error as Error).message ?? error)) }); }
    finally { controller.abort(); await heartbeat; }
  }
  private async heartbeatLoop(envelope: InvocationEnvelope, controller: AbortController): Promise<void> {
    let expiresAt = Date.parse(envelope.leaseExpiresAt);
    while (!controller.signal.aborted) {
      const delay = Math.max(1, Math.floor((expiresAt - Date.now()) / 2));
      await this.options.sleep(delay, controller.signal).catch(() => undefined);
      if (controller.signal.aborted) break;
      const response = await this.options.client.heartbeat(envelope, { signal: controller.signal }).catch(() => undefined);
      if (!response?.leaseValid || response.cancellation === 'cancellation_requested') { controller.abort(); break; }
      expiresAt = Date.parse(response.leaseExpiresAt);
    }
  }
  private context(envelope: InvocationEnvelope, signal: AbortSignal): WorkerExecutionContext {
    const stageBinary = async (portName: string, content: BodyInit, mediaType: string, metadata: JsonRecord = {}) => {
      const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : new TextEncoder().encode(String(content));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const stage = await this.options.client.stageArtifact(envelope, { portName, mediaType, expectedDigest: digest, expectedSizeBytes: bytes.byteLength, metadata }, { signal });
      const uploaded = await this.options.client.uploadStagedContent(stage.uploadUrl, new Blob([bytes]), { signal });
      return { stagingId: uploaded.stagedRef, portName, digest: uploaded.digest, sizeBytes: uploaded.sizeBytes, mediaType, schemaId: String(metadata.schemaId ?? 'demo.schema'), schemaDigest: String(metadata.schemaDigest ?? digest), provenance: { kind: 'execution', executionId: envelope.executionId, attemptId: envelope.attemptId } } satisfies StagedArtifact;
    };
    return { envelope, client: this.options.client, signal, log: this.options.logger, stageBinary, stageJson: (portName, value, metadata) => stageBinary(portName, new Blob([new TextDecoder().decode(canonicalJson(value))]), 'application/json', metadata), invokeCapability: (handle, input, options) => this.options.client.invokeCapability(envelope, handle, input, { signal, ...options }) };
  }
}

export function canonicalJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(sortJson(value))); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as JsonRecord).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)])); return value; }
export function emptyResourceUsage() { return { cpuMilliseconds: 0, wallMilliseconds: 0, inputBytes: 0, outputBytes: 0, externalCalls: 0 }; }
