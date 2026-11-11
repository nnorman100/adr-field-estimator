import { capabilitiesFor, type Capability, type Role } from '@/lib/access';
import { accessFlags, flagsFromRows, type CompanyFlags, type FlagRow } from '@/lib/flags';
import { sessionRefusal, type RouteSessionRule, type SessionClaims } from './policy';

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

// The revocation-checked token also carries what the second-step and session rules read, and the
// account's email and name, which only invitation matching and a new actor's record use.
export type AccountClaims = { email?: string | null; name?: string | null };
export type SessionToken = VerifiedToken & SessionClaims & AccountClaims;

export type TokenVerifier = {
  // Checks the token without the revocation call.
  verify(idToken: string): Promise<VerifiedToken>;
  // Checks it again on that tenant, including revocation and a disabled account.
  verifyNotRevoked(idToken: string, tenant: string): Promise<SessionToken>;
};

export type CompanyStatus = 'active' | 'suspended' | 'archived';

// What the database holds for one sign-in, read inside withCompany for that company only.
export type MemberRecord = {
  company: { id: string; name: string; status: CompanyStatus };
  // null when no actor of this company has the token's tenant and uid.
  actor: { id: string; displayName: string | null } | null;
  // The actor's active membership, else its most recent disabled one, else null.
  membership: { role: Role; status: 'active' | 'disabled' } | null;
  // The company's stored feature switches (company_feature_flags); no row means off.
  flags: readonly FlagRow[];
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
  // The company's switches; every known flag is present, off unless the company turned it on.
  flags: CompanyFlags;
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
  // The role needs an authenticator-app second step and this sign-in did not use one (policy.ts).
  second_step_required: 403,
  // The sign-in is older than the role allows, or than a sensitive route allows (policy.ts).
  sign_in_again: 401,
  // An operator route, and the caller is not an active platform operator (an owner, estimator or
  // office user included).
  not_an_operator: 403,
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

export type ResolveOptions = {
  // What the route declared about the session rules; none means the strictest member route.
  route?: RouteSessionRule;
  // The time in seconds since the epoch; tests pass a fixed one.
  now?: () => number;
};

const nowInSeconds = () => Math.floor(Date.now() / 1000);

// A signed-in account of an active company, whether or not it is a member yet: the token is
// checked, the company found from its tenant, the token checked again with revocation on that
// tenant, and a verified email required. Shared by resolveIdentity and resolveAccount.
async function signedInAccount(request: Request, verifier: TokenVerifier, directory: IdentityDirectory) {
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
  return { companyId, tenant, token, record };
}

export async function resolveIdentity(
  request: Request,
  verifier: TokenVerifier,
  directory: IdentityDirectory,
  options: ResolveOptions = {},
): Promise<Identity> {
  const { companyId, tenant, token, record } = await signedInAccount(request, verifier, directory);
  if (!record.actor || !record.membership) throw new IdentityRefusal('not_a_member');
  if (record.membership.status !== 'active') throw new IdentityRefusal('member_disabled');

  // The second step and the sign-in age, for this role and this route.
  const now = (options.now ?? nowInSeconds)();
  const refused = sessionRefusal(record.membership.role, token, options.route ?? {}, now);
  if (refused) throw new IdentityRefusal(refused);

  const flags = flagsFromRows(record.flags);

  return {
    companyId,
    companyName: record.company.name,
    actorId: record.actor.id,
    displayName: record.actor.displayName,
    uid: token.uid,
    tenant,
    role: record.membership.role,
    capabilities: capabilitiesFor(record.membership.role, accessFlags(flags)),
    flags,
  };
}

// A signed-in account that may not be a member yet: someone opening or accepting an invitation.
// The session rules depend on the role being accepted, so the caller applies them (sessionRefusal)
// once it knows that role. The email is the token's verified email, lowercased.
export type Account = {
  companyId: string;
  companyName: string;
  tenant: string;
  uid: string;
  email: string;
  name: string | null;
  session: SessionClaims;
};

export async function resolveAccount(
  request: Request,
  verifier: TokenVerifier,
  directory: IdentityDirectory,
): Promise<Account> {
  const { companyId, tenant, token, record } = await signedInAccount(request, verifier, directory);
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
  // A verified token with no email cannot be matched to an invitation.
  if (email === '') throw new IdentityRefusal('email_unverified');
  const name = typeof token.name === 'string' ? Array.from(token.name.trim()).slice(0, 200).join('').trim() || null : null;
  return {
    companyId,
    companyName: record.company.name,
    tenant,
    uid: token.uid,
    email,
    name,
    session: { authTime: token.authTime, secondFactor: token.secondFactor },
  };
}

// The platform operator signing in (owner decision D6): an actor with no company, in an operator
// tenant, with an active platform_admins row. Found by platform_operator (migration 0006).
export type OperatorDirectory = {
  operatorFor(tenant: string, uid: string): Promise<string | null>;
};

export type Operator = { operatorId: string; uid: string; tenant: string };

// Who is calling an operator route, from the verified token alone. A company user's token names a
// company tenant, which never finds an operator, so it is refused before anything is read or
// written. The operator's session rules always apply in full: the second step is required on every
// operator route (D6), and the sign-in must be under 12 hours old (D7), or under 15 minutes for a
// route that changes a team or a second step.
export async function resolveOperator(
  request: Request,
  verifier: TokenVerifier,
  operators: OperatorDirectory,
  options: { freshSignIn?: boolean; now?: () => number } = {},
): Promise<Operator> {
  const idToken = bearerToken(request);
  const first = await verifier.verify(idToken);
  if (!first.tenant) throw new IdentityRefusal('not_an_operator');
  const tenant = first.tenant;

  const operatorId = await operators.operatorFor(tenant, first.uid);
  if (!operatorId) throw new IdentityRefusal('not_an_operator');

  const token = await verifier.verifyNotRevoked(idToken, tenant);
  if (token.tenant !== tenant || token.uid !== first.uid) throw new IdentityRefusal('invalid_token');
  if (!token.emailVerified) throw new IdentityRefusal('email_unverified');

  const now = (options.now ?? nowInSeconds)();
  const refused = sessionRefusal('operator', token, { freshSignIn: options.freshSignIn === true }, now);
  if (refused) throw new IdentityRefusal(refused);
  return { operatorId, uid: token.uid, tenant };
}
