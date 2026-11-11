import { afterEach, describe, expect, it, vi } from 'vitest';
import { hadSecondStep, rememberSecondStep } from '@/app/(auth)/second-step/remember';
import {
  authenticatorName,
  authenticatorUri,
  codeErrorMessage,
  enrolErrorMessage,
  enrolNeedsFreshSignIn,
  groupedKey,
  normalizeCode,
  secondStepExpired,
} from '@/lib/sign-in/second-step';

// The second-step screens' pure decisions (S3-14). tests/e2e/second-step.spec.ts drives the screens
// themselves, with the Firebase client replaced at its network boundary because the Auth emulator
// cannot do authenticator-app (TOTP) enrolment (tests/emu/totp.test.ts records that).

afterEach(() => vi.unstubAllGlobals());

describe('typed code', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    [' 123-456 ', '123456'],
    ['000000', '000000'],
  ])('reads %j as %s', (input, digits) => {
    expect(normalizeCode(input)).toBe(digits);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 34 5a', '١٢٣٤٥٦', '123456\n7'])(
    'refuses %j',
    (input) => {
      expect(normalizeCode(input)).toBeNull();
    },
  );
});

describe('authenticator address', () => {
  const parts = {
    issuer: 'DryScope Company A',
    account: 'owner+test@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    digits: 6,
    periodSeconds: 30,
    algorithm: 'SHA1',
  };

  it('encodes every part and carries the key, digits and period', () => {
    expect(authenticatorUri(parts)).toBe(
      'otpauth://totp/DryScope%20Company%20A:owner%2Btest%40example.com' +
        '?secret=JBSWY3DPEHPK3PXP&issuer=DryScope%20Company%20A&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('cannot be bent by a company name or email with address characters in it', () => {
    const uri = authenticatorUri({ ...parts, issuer: 'A&secret=EVIL#', account: 'x:y/z?q=1' });
    const url = new URL(uri);
    expect(url.searchParams.getAll('secret')).toEqual(['JBSWY3DPEHPK3PXP']);
    expect(url.hash).toBe('');
    expect(url.searchParams.get('issuer')).toBe('A&secret=EVIL#');
  });

  it('shows the key in groups of four', () => {
    expect(groupedKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupedKey('ABCDE')).toBe('ABCD E');
    expect(groupedKey('')).toBe('');
  });
});

describe('names and messages', () => {
  it('names a spare apart from the first authenticator app', () => {
    expect(authenticatorName(0)).toBe('Authenticator app');
    expect(authenticatorName(1)).toBe('Authenticator app 2');
    expect(authenticatorName(2)).toBe('Authenticator app 3');
  });

  it('says a wrong code did not match, in both steps, without echoing anything', () => {
    for (const message of [
      codeErrorMessage('auth/invalid-verification-code'),
      enrolErrorMessage('auth/invalid-verification-code'),
    ]) {
      expect(message).toMatch(/did not match/);
    }
    expect(codeErrorMessage('auth/too-many-requests')).toMatch(/Too many tries/);
    expect(codeErrorMessage('auth/network-request-failed')).toMatch(/No connection/);
  });

  it('gives an unknown or missing code the general words, never the error text', () => {
    expect(codeErrorMessage('auth/something-new')).toBe(
      'The code could not be checked. Try again.',
    );
    expect(codeErrorMessage(undefined)).toBe('The code could not be checked. Try again.');
    expect(enrolErrorMessage(null)).toBe('The authenticator app could not be set up. Try again.');
  });

  it('knows which errors end the step and which need a newer sign-in', () => {
    expect(secondStepExpired('auth/invalid-multi-factor-session')).toBe(true);
    expect(secondStepExpired('auth/code-expired')).toBe(true);
    expect(secondStepExpired('auth/invalid-verification-code')).toBe(false);
    expect(secondStepExpired('auth/network-request-failed')).toBe(false);
    expect(enrolNeedsFreshSignIn('auth/requires-recent-login')).toBe(true);
    expect(enrolNeedsFreshSignIn('auth/invalid-verification-code')).toBe(false);
    expect(enrolErrorMessage('auth/requires-recent-login')).toMatch(/sign in again/);
  });

  it("says the account has as many authenticator apps as it can have at Firebase's limit", () => {
    expect(enrolErrorMessage('auth/maximum-second-factor-count-exceeded')).toBe(
      'This account already has as many authenticator apps as it can have.',
    );
  });
});

function storage(initial: Record<string, string> = {}, broken = false) {
  const data = new Map(Object.entries(initial));
  const refuse = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: broken ? refuse : (key: string) => data.get(key) ?? null,
      setItem: broken ? refuse : (key: string, value: string) => void data.set(key, value),
    },
  });
  return data;
}

describe('remembered second step', () => {
  it('is remembered for one company and one account only, with no email in the key', () => {
    const data = storage();
    rememberSecondStep('tenant-a', 'uid-1');
    expect(hadSecondStep('tenant-a', 'uid-1')).toBe(true);
    expect(hadSecondStep('tenant-a', 'uid-2')).toBe(false);
    expect(hadSecondStep('tenant-b', 'uid-1')).toBe(false);
    expect([...data.keys()]).toEqual(['dryscope.secondStep.tenant-a.uid-1']);
    expect([...data.values()]).toEqual(['1']);
  });

  it('only counts the exact marker', () => {
    storage({ 'dryscope.secondStep.tenant-a.uid-1': 'yes' });
    expect(hadSecondStep('tenant-a', 'uid-1')).toBe(false);
  });

  it('copes with storage that is blocked', () => {
    storage({}, true);
    expect(() => rememberSecondStep('tenant-a', 'uid-1')).not.toThrow();
    expect(hadSecondStep('tenant-a', 'uid-1')).toBe(false);
  });
});
