// The company sign-in page (owner decision D5): each company has its own sign-in address,
// `/sign-in/{address}`, which the phone remembers and invitations carry. Before anyone signs in,
// the page needs the company's name and its Identity Platform tenant, because the browser must
// sign in to that tenant. Both are public: the tenant id goes to every visitor's browser.
//
// The server reads it through sign_in_company_page (migration 0007, S3-13b), see
// database-directory.ts; on a developer machine beside the Auth emulator the local stand-in
// (local-directory.ts) answers instead.

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

// A directory that recognises no address.
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
