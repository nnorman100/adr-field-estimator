import { apiFetch } from '@/lib/api-fetch';
import { LINK_TOKEN_HEADER } from './header';

// The homeowner's and adjuster's pages' calls to this app's link routes (S5a-11b). The token goes in
// its header only; nothing is cached, and no request sends a referrer.

export type LinkAnswer = { status: number; body: unknown };

async function linkFetch(token: string, path: string, init: { method?: string; json?: unknown; bytes?: Uint8Array; type?: string } = {}): Promise<Response | null> {
  const headers: Record<string, string> = { [LINK_TOKEN_HEADER]: token };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.bytes) {
    headers['Content-Type'] = init.type ?? 'application/octet-stream';
    body = init.bytes as BodyInit;
  }
  try {
    return await apiFetch(path, { method: init.method ?? 'GET', headers, body, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' });
  } catch {
    return null;
  }
}

export async function linkCall(token: string, path: string, init: { method?: string; json?: unknown; bytes?: Uint8Array; type?: string } = {}): Promise<LinkAnswer> {
  const response = await linkFetch(token, path, init);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** An image a link route answers, as a local address for an <img>, or null when it cannot be read now. */
export async function linkImageAddress(token: string, path: string): Promise<string | null> {
  const response = await linkFetch(token, path);
  if (!response?.ok) return null;
  const bytes = await response.blob().catch(() => null);
  return bytes ? URL.createObjectURL(bytes) : null;
}
