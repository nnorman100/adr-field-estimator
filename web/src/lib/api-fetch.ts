import { CLIENT_EPOCH, CLIENT_EPOCH_HEADER, UPDATE_REQUIRED } from './app-version';
import { beginUpdateActivity, requireAppUpdate } from './update-activity';

// Browser calls to this app's own API. Keep the compiled epoch with the code sending the write.
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  activity: 'save' | 'upload' = 'save',
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!path.startsWith('/api/') || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return fetch(path, init);
  const headers = new Headers(init.headers);
  headers.set(CLIENT_EPOCH_HEADER, String(CLIENT_EPOCH));
  const end = typeof window !== 'undefined' ? beginUpdateActivity(activity) : undefined;
  try {
    const response = await fetch(path, { ...init, headers });
    if (response.status === 426) {
      const body = await response.clone().json().catch(() => null);
      if (body?.error === UPDATE_REQUIRED) requireAppUpdate();
    }
    return response;
  } finally {
    end?.();
  }
}
