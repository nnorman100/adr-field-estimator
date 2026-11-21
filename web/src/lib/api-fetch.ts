import { CLIENT_EPOCH, CLIENT_EPOCH_HEADER, UPDATE_REQUIRED } from './app-version';
import { beginUpdateActivity, requireAppUpdate } from './update-activity';

const READS = ['GET', 'HEAD', 'OPTIONS'];
const isWrite = (method: string | undefined): boolean => !READS.includes((method ?? 'GET').toUpperCase());

// Browser calls to this app's own API. Keep the compiled epoch with the code sending the write.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/api/') || !isWrite(init.method)) return fetch(path, init);
  const headers = new Headers(init.headers);
  headers.set(CLIENT_EPOCH_HEADER, String(CLIENT_EPOCH));
  const response = await fetch(path, { ...init, headers });
  if (response.status === 426) {
    const body = await response.clone().json().catch(() => null);
    if (body?.error === UPDATE_REQUIRED) requireAppUpdate();
  }
  return response;
}

// One whole write the person started, for as long as Update now must wait for it: the caller's
// token and App Check preparation before the request, and reading the answer after it.
export async function trackedWrite<T>(method: string | undefined, activity: 'save' | 'upload', work: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined' || !isWrite(method)) return work();
  const end = beginUpdateActivity(activity);
  try {
    return await work();
  } finally {
    end();
  }
}
