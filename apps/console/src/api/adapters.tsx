export const camel = (s: string) =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [camel(k), normalize(v)]),
    );
  return value;
}
export function shortId(value: unknown) {
  const s = String(value ?? '');
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
