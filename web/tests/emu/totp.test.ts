// Records a known gap: the Auth emulator emulates text-message second factors only, so the
// real authenticator-app (TOTP) step cannot be proved here and is checked against the real
// test environment instead. If a later emulator accepts TOTP, this test fails so the gap is
// looked at again rather than silently assumed.
import { describe, expect, it } from 'vitest';
import { call, createTenant, errorMessage, markEmailVerified, signIn, signUp } from './auth-emulator';

describe('Auth emulator second factor', () => {
  it('refuses authenticator-app (TOTP) enrolment, while text-message enrolment works', async () => {
    const tenantId = await createTenant('company-totp', {
      mfaConfig: {
        state: 'ENABLED',
        enabledProviders: ['PHONE_SMS'],
        providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 5 } }],
      },
    });
    const email = 'owner@company-totp.example.test';
    const password = 'synthetic-password-totp';
    const localId = await signUp(tenantId, email, password);
    await markEmailVerified(tenantId, localId);
    const idToken = await signIn(tenantId, email, password);

    const totp = await call('/v2/accounts/mfaEnrollment:start', { idToken, tenantId, totpEnrollmentInfo: {} });
    expect(totp.status).toBe(400);
    expect(totp.body.totpSessionInfo).toBeUndefined();
    expect(errorMessage(totp)).toMatch(/phoneEnrollmentInfo/);

    // Control: the same signed-in, verified user can start a text-message enrolment, so the
    // refusal above is about TOTP and not about the tenant or user setup.
    const sms = await call('/v2/accounts/mfaEnrollment:start', {
      idToken,
      tenantId,
      phoneEnrollmentInfo: { phoneNumber: '+15555550100' },
    });
    expect(sms.status).toBe(200);
    expect(sms.body.phoneSessionInfo).toBeDefined();
  });
});
