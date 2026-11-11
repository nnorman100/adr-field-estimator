// The company sign-in page (owner decision D5): each company has its own sign-in address,
// `/sign-in/{address}`, which the phone remembers and invitations carry. Before anyone signs in,
// the page needs the company's name and its Identity Platform tenant, because the browser must
// sign in to that tenant. Both are public: the tenant id goes to every visitor's browser.
//
// This step (S3-13a) has no database lookup for it. The SQL function that reads a company by its
// address is a later database job (S3-13b, docs/plans/S3.md Corrections); until it lands, every
// address answers "not recognised" outside the local emulator stand-in (local-directory.ts).

export type SignInPage = { companyName: string; tenantId: string };

export type SignInDirectory = {
  // The page of an active company with a sign-in tenant, or null for anything else.
  pageFor(address: string): Promise<SignInPage | null>;
};

// The address rule of companies_sign_in_slug_check (migration 0002).
const SIGN_IN_ADDRESS = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function isSignInAddress(value: unknown): value is string {
  return typeof value === 'string' && SIGN_IN_ADDRESS.test(value);
}

// Until S3-13b: no address is recognised.
export const noSignInDirectory: SignInDirectory = Object.freeze({
  async pageFor() {
    return null;
  },
});

// A malformed address never reaches a directory.
export async function signInPageFor(directory: SignInDirectory, address: unknown): Promise<SignInPage | null> {
  if (!isSignInAddress(address)) return null;
  return directory.pageFor(address);
}
