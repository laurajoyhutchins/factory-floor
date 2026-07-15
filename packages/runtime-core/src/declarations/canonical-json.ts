import { createHash } from 'node:crypto';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [k: string]: CanonicalJson };

function norm(value: unknown, seen = new WeakSet<object>()): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not canonical JSON');
    return value;
  }
  if (
    typeof value === 'undefined'
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical JSON value');
  if (seen.has(value)) throw new TypeError('Cyclic data is not canonical JSON');

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => norm(item, seen));

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain objects are canonical JSON objects');
    }

    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = norm((value as Record<string, unknown>)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(norm(value));
}

export function canonicalJsonDigest(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}
