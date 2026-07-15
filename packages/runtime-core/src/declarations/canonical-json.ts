import { createHash } from 'node:crypto';
export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [k: string]: CanonicalJson };
function norm(v: unknown, seen = new WeakSet<object>()): CanonicalJson {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('Non-finite numbers are not canonical JSON'); return v; }
  if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new TypeError(`Unsupported canonical JSON value: ${typeof v}`);
  if (Array.isArray(v)) return v.map((x) => norm(x, seen));
  if (typeof v === 'object') {
    if (seen.has(v)) throw new TypeError('Cyclic data is not canonical JSON');
    seen.add(v);
    const out: Record<string, CanonicalJson> = {};
    for (const k of Object.keys(v).sort()) out[k] = norm((v as Record<string, unknown>)[k], seen);
    seen.delete(v); return out;
  }
  throw new TypeError('Unsupported canonical JSON value');
}
export function canonicalizeJson(value: unknown): string { return JSON.stringify(norm(value)); }
export function canonicalJsonDigest(value: unknown): string { return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex'); }
