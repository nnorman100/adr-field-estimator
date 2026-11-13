// The one canonical form of a field draft (docs/plans/S5.md, section 4, step 1): the draft's
// `field` map, each room document and each photo reference document, as the phone shows them and as
// the server reads them after the fence closes. "Finish and review" on the phone and Submit on the
// server both hash this form, so a digest that differs means the server would record something
// other than what the technician saw (another phone's edit landed, a write never arrived).
//
// The form: one JSON text, object keys sorted by code unit at every depth, the rooms and the photo
// references each sorted by document id, no spaces. Only what the field rules let a document hold
// may appear (text, numbers, true and false, lists and maps); anything else is refused, so the two
// sides can never hash a value one of them cannot spell. Shared by the browser and the server, so it
// uses Web Crypto, which both have.

/** One room or photo reference document: its id and its `field` map. */
export type FieldDoc = { id: string; field: unknown };

/** What a draft holds: the job-level `field` map and its nested documents. */
export type FieldManifest = { draft: unknown; rooms: FieldDoc[]; photos: FieldDoc[] };

export class CanonicalFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalFormError';
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function plainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** JSON with sorted keys; throws on a value outside what the field maps may hold. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalFormError('a number is not finite');
    // -0 and 0 are one value to a person and to the engine.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && plainObject(value)) {
    const keys = Object.keys(value).sort(byCodeUnit);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new CanonicalFormError('a value is not text, a number, true or false, a list or a map');
}

function sortedDocs(docs: FieldDoc[], label: string): FieldDoc[] {
  const ids = new Set<string>();
  for (const doc of docs) {
    if (typeof doc.id !== 'string' || doc.id === '') throw new CanonicalFormError(`a ${label} has no id`);
    if (ids.has(doc.id)) throw new CanonicalFormError(`a ${label} is listed twice`);
    ids.add(doc.id);
  }
  return [...docs].sort((a, b) => byCodeUnit(a.id, b.id)).map((doc) => ({ id: doc.id, field: doc.field ?? {} }));
}

/** The canonical text of a draft. A missing `field` map is an empty one. */
export function canonicalManifest(manifest: FieldManifest): string {
  return canonicalJson({
    draft: manifest.draft ?? {},
    photos: sortedDocs(manifest.photos, 'photo reference'),
    rooms: sortedDocs(manifest.rooms, 'room'),
  });
}

/** SHA-256 of the canonical text (UTF-8), as 64 lowercase hex characters. */
export async function manifestDigest(manifest: FieldManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifest(manifest));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
