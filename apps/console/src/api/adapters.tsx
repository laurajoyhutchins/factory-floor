export const camel = (s: string) =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const OPAQUE_RUNTIME_FIELDS = new Set([
  'attributes',
  'configuration',
  'definition',
  'failure',
  'input_payload',
  'metadata',
  'modifications',
  'normalized_inputs',
  'payload',
  'provenance',
  'result',
  'schema',
  'topology',
]);

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        camel(key),
        OPAQUE_RUNTIME_FIELDS.has(key) ? child : normalize(child),
      ]),
    );
  return value;
}

export function shortId(value: unknown) {
  const s = String(value ?? '');
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
