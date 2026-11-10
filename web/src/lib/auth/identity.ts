import { capabilitiesFor, type Capability, type Role } from '@/lib/access';

// Who is calling, decided only from the verified sign-in token: tenant, then company, then the
// actor and membership. A company id in a URL, header or body is never read here, so it cannot
// change the result. Resolving an identity reads and never writes.

// Claims of a sign-in token whose signature, audience, issuer and expiry were checked.
export type VerifiedToken = {
  uid: string;
  // The Identity Platform tenant the user signed in to; null for a user outside any tenant.
  tenant: string | null;
  emailVerified: boolean;
};

export type TokenVerifier = {
  // Checks the token without the revocation call.
  verify(idToken: string): Promise<VerifiedToken>;
  // Checks it again on that tenant, including revocation and a disabled account.
  verifyNotRevoked(idToken: string, tenant: string): Promise<VerifiedToken>;
};

export type CompanyStatus = 'active' | 'suspended' | 'archived';

// What the database holds for one sign-in, read inside withCompany for that company only.
export type MemberRecord = {
  company: { id: string; name: string; status: CompanyStatus };
  // null when no actor of this company has the token's tenant and uid.
  actor: { id: string; displayName: string | null } | null;
  // The actor's active membership, else its most recent disabled one, else null.
  membership: { role: Role; status: 'active' | 'disabled' } | null;
};

export type IdentityDirectory = {
  // The company signed in through this tenant, or null for an unknown or operator tenant.
  companyForTenant(tenant: string): Promise<string | null>;
  member(companyId: string, tenant: string, uid: string): Promise<MemberRecord | null>;
};

export type Identity = {
  companyId: string;
  companyName: string;
  actorId: string;
  displayName: string | null;
  uid: string;
  tenant: string;
  role: Role;
  capabilities: readonly Capability[];
};

// Why a request was refused. The code goes back to the browser; nothing else does.
export const REFUSALS = {
  missing_token: 401,
  invalid_token: 401,
  sign_in_revoked: 401,
  account_disabled: 403,
  no_tenant: 403,
  unknown_tenant: 403,
  email_unverified: 403,
  not_a_member: 403,
  member_disabled: 403,
  company_inactive: 403,
} as const;
export type RefusalCode = keyof typeof REFUSALS;

export class IdentityRefusal extends Error {
  readonly status: number;
  constructor(readonly code: RefusalCode) {
    super(`Sign-in refused: ${code}`);
    this.name = 'IdentityRefusal';
    this.status = REFUSALS[code];
  }
}

// A JWT is three base64url parts. Anything longer than this is not a Firebase ID token.
const MAX_TOKEN_LENGTH = 8192;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

// The token from `Authorization: Bearer <token>`, or a refusal. Cookies and query strings are
// never read.
export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization');
  if (!header) throw new IdentityRefusal('missing_token');
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH || !JWT.test(token)) {
    throw new IdentityRefusal('invalid_token');
  }
  return token;
}

// Price books stay off until per-company switches exist (S3-11).
const FLAGS = Object.freeze({ priceBooks: false });

export async function resolveIdentity(
  request: Request,
  verifier: TokenVerifier,
  directory: IdentityDirectory,
): Promise<Identity> {
  const idToken = bearerToken(request);

  const first = await verifier.verify(idToken);
  if (!first.tenant) throw new IdentityRefusal('no_tenant');
  const tenant = first.tenant;

  const companyId = await directory.companyForTenant(tenant);
  if (!companyId) throw new IdentityRefusal('unknown_tenant');

  const token = await verifier.verifyNotRevoked(idToken, tenant);
  // The verifier already refuses another tenant; this keeps the rule visible here.
  if (token.tenant !== tenant || token.uid !== first.uid) throw new IdentityRefusal('invalid_token');
  if (!token.emailVerified) throw new IdentityRefusal('email_unverified');

  const record = await directory.member(companyId, tenant, token.uid);
  if (!record || record.company.id !== companyId) throw new IdentityRefusal('unknown_tenant');
  if (record.company.status !== 'active') throw new IdentityRefusal('company_inactive');
  if (!record.actor || !record.membership) throw new IdentityRefusal('not_a_member');
  if (record.membership.status !== 'active') throw new IdentityRefusal('member_disabled');

  return {
    companyId,
    companyName: record.company.name,
    actorId: record.actor.id,
    displayName: record.actor.displayName,
    uid: token.uid,
    tenant,
    role: record.membership.role,
    capabilities: capabilitiesFor(record.membership.role, FLAGS),
  };
}
