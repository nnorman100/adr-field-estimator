import { apiFetch } from '@/lib/api-fetch';
import type { User } from 'firebase/auth';
import type { ApiAnswer } from '@/lib/firebase-client';

// The signing screen's two byte calls to this app's photo route (S5a-5): sending the signature image
// and reading it back for the signed page. JSON calls go through callApi (src/lib/firebase-client.ts);
// these carry raw bytes, as the field screens' photo calls do (src/lib/field/api.ts).

async function authorized(user: User, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    const token = await user.getIdToken();
    return await apiFetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, cache: 'no-store' }, 'upload');
  } catch {
    return null;
  }
}

/** Sends the signature image (PNG bytes) under the phone's own id, bound to the proposal it was drawn for; the same bytes again answer the same receipt. */
export async function sendSignature(user: User, jobId: string, signatureId: string, png: Uint8Array, proposalSha256: string): Promise<ApiAnswer> {
  const response = await authorized(user, `/api/jobs/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(signatureId)}?kind=signature`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'X-Proposal-Sha256': proposalSha256 },
    body: png as BodyInit,
  });
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The stored signature image as a local address for an <img>, or null when it cannot be read now. */
export async function signatureAddress(user: User, jobId: string, signatureId: string): Promise<string | null> {
  const response = await authorized(user, `/api/jobs/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(signatureId)}?kind=signature`);
  if (!response?.ok) return null;
  const bytes = await response.blob().catch(() => null);
  return bytes ? URL.createObjectURL(bytes) : null;
}
