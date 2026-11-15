// A small client for the Firestore emulator's REST API, enough for the rules tests. `admin`
// calls use the emulator's `Bearer owner` token, which skips the rules the way the server SDK
// does, and stand in for the server writing its own records. User calls carry an Auth emulator
// ID token, so the rules see that user's uid and sign-in tenant.
import { requireEmulatorEnv } from '../guard';

const { projectId, firestoreHost } = requireEmulatorEnv(process.env);
const documents = `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents`;

export type Caller = 'admin' | { idToken: string } | null;
export type Data = Record<string, unknown>;

type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values: Value[] } }
  | { mapValue: { fields: Record<string, Value> } };

function encode(value: unknown): Value {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value as Data) } };
  throw new Error(`Cannot encode a ${typeof value} for Firestore`);
}

function encodeFields(data: Data): Record<string, Value> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)]));
}

function headers(caller: Caller): Record<string, string> {
  const base = { 'Content-Type': 'application/json' };
  if (caller === 'admin') return { ...base, Authorization: 'Bearer owner' };
  if (caller) return { ...base, Authorization: `Bearer ${caller.idToken}` };
  return base;
}

async function send(caller: Caller, url: string, method: string, body?: unknown): Promise<number> {
  const response = await fetch(url, {
    method,
    headers: headers(caller),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response.status;
}

function mask(fieldPaths: string[]): string {
  return fieldPaths.map((path) => `updateMask.fieldPaths=${encodeURIComponent(path)}`).join('&');
}

// Writes the whole document as the server would, creating it if needed.
export async function serverSet(path: string, data: Data): Promise<void> {
  const status = await send('admin', `${documents}/${path}`, 'PATCH', { fields: encodeFields(data) });
  if (status !== 200) throw new Error(`Server write of ${path} answered ${status}`);
}

export function getDoc(caller: Caller, path: string): Promise<number> {
  return send(caller, `${documents}/${path}`, 'GET');
}

// Lists a collection, such as `companies/x/drafts`.
export function listDocs(caller: Caller, collectionPath: string): Promise<number> {
  return send(caller, `${documents}/${collectionPath}`, 'GET');
}

// Changes only the named top-level fields of an existing document.
export function updateDoc(caller: Caller, path: string, data: Data): Promise<number> {
  return send(
    caller,
    `${documents}/${path}?${mask(Object.keys(data))}&currentDocument.exists=true`,
    'PATCH',
    {
      fields: encodeFields(data),
    },
  );
}

// Creates a document that must not exist yet.
export function createDoc(caller: Caller, path: string, data: Data): Promise<number> {
  return send(caller, `${documents}/${path}?currentDocument.exists=false`, 'PATCH', {
    fields: encodeFields(data),
  });
}

export function deleteDoc(caller: Caller, path: string): Promise<number> {
  return send(caller, `${documents}/${path}`, 'DELETE');
}

// Runs a structured query on one collection under `parentPath` (a document path, or '' for the
// root), filtered by one string field, as a client SDK's `where(field, '==', value)` sends it.
export function queryDocs(caller: Caller, parentPath: string, collectionId: string, field: string, value: string): Promise<number> {
  return send(caller, `${documents}${parentPath ? `/${parentPath}` : ''}:runQuery`, 'POST', {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encode(value) } },
    },
  });
}

export type Write = { path: string; data: Data; create?: boolean };

// One batched write (a `commit` with several writes), as the phone's SDK sends a `writeBatch`.
// A create must not exist yet; any other write changes only the named top-level fields of an
// existing document. The rules see every write of the batch in one request.
export function commit(caller: Caller, writes: Write[]): Promise<number> {
  const name = (path: string) => `projects/${projectId}/databases/(default)/documents/${path}`;
  return send(caller, `${documents}:commit`, 'POST', {
    writes: writes.map((write) => ({
      update: { name: name(write.path), fields: encodeFields(write.data) },
      ...(write.create ? {} : { updateMask: { fieldPaths: Object.keys(write.data) } }),
      currentDocument: { exists: !write.create },
    })),
  });
}
