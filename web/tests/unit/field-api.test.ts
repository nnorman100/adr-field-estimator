import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';

// The job screens' answer rule (S5a-6): a success whose body did not arrive whole is no answer, so
// the screen keeps the request and sends it again with the same ids instead of making new ones.
const callApi = vi.fn();
vi.mock('@/lib/firebase-client', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));

const { createJob, photoAddress, readJob, saveCustomer } = await import('@/lib/field/api');

const user = { getIdToken: async () => 'token' } as unknown as User;
const JOB = { id: '0b8f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b', draftId: '1b8f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b', propertyAddress: '' };

describe('job screen answers', () => {
  beforeEach(() => callApi.mockReset());

  it('takes a created job whose answer did not arrive whole as no answer', async () => {
    callApi.mockResolvedValue({ status: 201, body: null });
    expect(await createJob(user, JOB)).toMatchObject({ ok: false, status: 0 });
    callApi.mockResolvedValue({ status: 200, body: { job: { id: 'cut short' } } });
    expect(await createJob(user, JOB)).toMatchObject({ ok: false, status: 0 });
  });

  it('takes a saved customer whose answer did not arrive whole as no answer, and a stale revision as stale', async () => {
    const input = { name: '', phone: '', email: '', propertyAddress: '', revision: 1, changeId: JOB.id };
    callApi.mockResolvedValue({ status: 200, body: null });
    expect(await saveCustomer(user, JOB.id, input)).toMatchObject({ ok: false, status: 0 });
    callApi.mockResolvedValue({ status: 409, body: { error: 'stale_revision', revision: 3 } });
    expect(await saveCustomer(user, JOB.id, input)).toMatchObject({ ok: false, status: 409, stale: true });
    callApi.mockResolvedValue({ status: 409, body: { error: 'conflict' } });
    expect(await saveCustomer(user, JOB.id, input)).toEqual(expect.not.objectContaining({ stale: true }));
  });

  it('marks a refusal to show the job to this person as denied, and no answer or a server failure as not', async () => {
    for (const [status, error] of [[404, 'not_found'], [403, 'forbidden'], [401, 'unauthenticated']] as const) {
      callApi.mockResolvedValue({ status, body: { error } });
      expect(await readJob(user, JOB.id)).toMatchObject({ ok: false, status, denied: true });
    }
    for (const status of [0, 500, 503]) {
      callApi.mockResolvedValue({ status, body: null });
      expect(await readJob(user, JOB.id)).toEqual(expect.not.objectContaining({ denied: true }));
    }
    const input = { name: '', phone: '', email: '', propertyAddress: '', revision: 1, changeId: JOB.id };
    callApi.mockResolvedValue({ status: 409, body: { error: 'stale_revision', revision: 3 } });
    expect(await saveCustomer(user, JOB.id, input)).toEqual(expect.not.objectContaining({ denied: true }));
  });
});

describe('photo bytes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers null when the bytes are cut off after the headers, so the photo shows as not available', async () => {
    const cutOff = { ok: true, status: 200, blob: () => Promise.reject(new TypeError('network error')) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cutOff));
    expect(await photoAddress(user, JOB.id, JOB.draftId)).toBeNull();
  });
});
