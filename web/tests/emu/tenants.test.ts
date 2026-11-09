import { describe, expect, it } from 'vitest';
import { createTenant, projectId, signIn, signUp, tokenClaims } from './auth-emulator';

describe('Auth emulator tenants', () => {
  it('signs a user into each of two tenants and puts that tenant in each token', async () => {
    const tenants = [await createTenant('company-a'), await createTenant('company-b')];
    expect(tenants[0]).not.toBe(tenants[1]);

    for (const [index, tenantId] of tenants.entries()) {
      const email = `owner-${index}@company.example.test`;
      const password = `synthetic-password-${index}`;
      await signUp(tenantId, email, password);
      const claims = tokenClaims(await signIn(tenantId, email, password));
      expect(claims.aud).toBe(projectId);
      expect((claims.firebase as { tenant?: string }).tenant).toBe(tenantId);
    }
  });
});
