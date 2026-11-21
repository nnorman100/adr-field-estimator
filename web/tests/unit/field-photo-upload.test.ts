import type { User } from 'firebase/auth';
import { afterEach, expect, it, vi } from 'vitest';
import { sendPhoto, sendQueuedPhoto } from '@/lib/field/api';
import { appCheckHeaders } from '@/lib/app-check-client';

vi.mock('@/lib/app-check-client', () => ({ appCheckHeaders: vi.fn() }));
vi.mock('@/lib/firebase-client', () => ({ callApi: vi.fn() }));

const entry = {
  tenantId: 'company-a',
  uid: 'tech',
  jobId: 'job',
  draftId: 'draft',
  photoId: 'photo',
  kind: 'original' as const,
  field: {},
  sha256: 'a'.repeat(64),
  photoSha256: 'b'.repeat(64),
  contentType: 'image/jpeg',
};
const user = { getIdToken: async () => 'test-id' } as User;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('uses the signed-in photo route, refreshes a refused App Check credential, and exposes the original receipt', async () => {
  vi.mocked(appCheckHeaders).mockImplementation(async (refresh) => ({ 'X-Firebase-AppCheck': refresh ? 'new-test-token' : 'old-test-token' }));
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: 'app_check_required' }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ photoId: entry.photoId, sha256: entry.sha256 }, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const photo = new Blob([new Uint8Array([7, 8, 9])], { type: entry.contentType });
  expect(await sendQueuedPhoto(user, entry, photo, signal)).toEqual({ ok: true, value: { photoId: entry.photoId, sha256: entry.sha256 } });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [index, token] of ['old-test-token', 'new-test-token'].entries()) {
    expect(fetch).toHaveBeenNthCalledWith(index + 1, '/api/jobs/job/photos/photo?kind=original', {
      method: 'PUT', cache: 'no-store', signal, body: new Uint8Array([7, 8, 9]),
      headers: {
        Authorization: 'Bearer test-id',
        'Content-Type': 'image/jpeg',
        'X-Photo-Sha256': entry.photoSha256,
        'X-Firebase-AppCheck': token,
      },
    });
  }
});

it('passes Retry-After and the server code to the queue', async () => {
  vi.mocked(appCheckHeaders).mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'rate_limit' }, { status: 429, headers: { 'Retry-After': '45' } })));
  const photo = new Blob([new Uint8Array([1])], { type: entry.contentType });
  expect(await sendQueuedPhoto(user, { ...entry, kind: 'photo' }, photo, new AbortController().signal)).toMatchObject({
    ok: false, status: 429, code: 'rate_limit', retryAfter: '45',
  });
});

it('does not repeat the online-only photo request after an App Check refusal', async () => {
  vi.mocked(appCheckHeaders).mockResolvedValue({});
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'app_check_required' }, { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  expect(await sendPhoto(user, 'job', 'photo', new Blob([new Uint8Array([1])], { type: 'image/jpeg' }))).toMatchObject({ ok: false, status: 401 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
