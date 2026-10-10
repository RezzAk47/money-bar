// JSON with sorted keys and the strict-decode helpers (named errors) used by entries.json.
export type Extra = Record<string, unknown>;
export class DecodeError extends Error { constructor(message: string) { super(message); this.name = 'DecodeError'; } }
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}
export function shown(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return 'an object';
}
/** A null-prototype dictionary: any string, "__proto__" and "constructor" included, is an ordinary key. */
export function dict<T>(entries: Iterable<[string, T]> = []): Record<string, T> {
  const d: Record<string, T> = Object.create(null);
  for (const [k, v] of entries) d[k] = v;
  return d;
}
export function unknownKeys(obj: Record<string, unknown>, known: readonly string[]): Extra | undefined {
  const extra: Extra = Object.create(null); let any = false;
  for (const k of Object.keys(obj)) if (!known.includes(k)) { extra[k] = obj[k]; any = true; }
  return any ? extra : undefined;
}
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function newId(): string { return crypto.randomUUID().toUpperCase(); }
