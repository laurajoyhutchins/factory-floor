import { canonicalJsonDigest } from '../declarations/canonical-json.js';
export function commandRequestDigest(input: { region: string; commandType: string; source: unknown; payload: unknown; correlationId?: string | null; expiresAt?: string | null }): string { return canonicalJsonDigest({ region: input.region, commandType: input.commandType, source: input.source ?? {}, payload: input.payload ?? {}, correlationId: input.correlationId ?? null, expiresAt: input.expiresAt ?? null }); }
export function payloadDigest(payload: unknown): string { return canonicalJsonDigest(payload ?? {}); }
export interface InputIdentity { portName: string; deliveryId: string; sourceKind: 'command'|'event'; sourceId: string; payloadDigest: string }
export function inputSetDigest(inputs: InputIdentity[]): string { return canonicalJsonDigest([...inputs].sort((a,b)=> a.portName.localeCompare(b.portName) || a.deliveryId.localeCompare(b.deliveryId))); }
