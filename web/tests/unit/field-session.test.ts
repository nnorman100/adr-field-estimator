import { describe, expect, it, vi } from 'vitest';
import type { DsMe } from '@/lib/field/ds-me';

// The job screens stop showing a person's work once the phone's sign-in for the company changes
// (S5a-6), in this tab or another: Firebase reports every change of the signed-in person.
let report: (user: { uid: string } | null) => void = () => undefined;
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, next: typeof report) => {
    report = next;
    return () => undefined;
  },
}));
vi.mock('@/lib/firebase-client', () => ({ companyAuth: () => ({}), callApi: vi.fn() }));

const { sessionIdentity, watchSignIn } = await import('@/lib/field/session');

describe('watching the sign-in', () => {
  it('calls lost when the person signs out or someone else signs in, and not for the same person', () => {
    const lost = vi.fn();
    watchSignIn({ tenantId: 't', uid: 'a' } as DsMe, 'a', lost);
    report({ uid: 'a' });
    expect(lost).not.toHaveBeenCalled();
    report({ uid: 'b' });
    expect(lost).toHaveBeenCalledTimes(1);
    report(null);
    expect(lost).toHaveBeenCalledTimes(2);
  });
});

describe('who the job screens start as (S5b-1)', () => {
  it('starts with company, role and actor id, and never guesses an actor id', () => {
    expect(sessionIdentity({ companyId: 'c', role: 'owner', actorId: 'a' })).toEqual({ companyId: 'c', role: 'owner', actorId: 'a' });
  });

  it('keeps a sign-in saved before the actor id was kept waiting for one online check', () => {
    expect(sessionIdentity({ companyId: 'c', role: 'owner', actorId: null })).toBe('needs-check');
  });

  it('has nothing to start from without a company or role', () => {
    expect(sessionIdentity({ companyId: null, role: 'owner', actorId: 'a' })).toBeNull();
    expect(sessionIdentity({ companyId: 'c', role: null, actorId: 'a' })).toBeNull();
  });
});

