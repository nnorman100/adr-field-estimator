import type { SignedAgreement, SignerRole } from '@/lib/agreements/screen';
import type { Json } from '@/engine/estimate';
import type { Proposal } from '@/lib/estimates/proposal';

// What the link screens decide in the browser (S5a-11b), as pure functions so they are unit-tested:
// the technician's Send to the homeowner and Share the signed documents panels, and the homeowner's
// and adjuster's pages. Messages come from fixed codes only, never from what someone typed.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The token in a page address's fragment (/sign#token), or null. The fragment never reaches a server. */
export function tokenFromFragment(hash: string): string | null {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  return TOKEN.test(token) ? token : null;
}

/** Reads the page's token from its fragment for useSyncExternalStore, following a changed fragment. */
export function watchFragment(changed: () => void): () => void {
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
}
export const fragmentToken = () => tokenFromFragment(window.location.hash);

/** The address a technician sends: the page, with the token only in the fragment. */
export function linkAddress(origin: string, page: 'sign' | 'documents', token: string): string {
  return `${origin.replace(/\/+$/, '')}/${page}#${token}`;
}

/** The caller's link rights from /api/me: who may make links (`sign`) and who may revoke document links (`delivery_resend`). */
export function linkRightsOf(me: unknown): { canSend: boolean; canRevoke: boolean } {
  const capabilities = field(me, 'capabilities');
  const list = Array.isArray(capabilities) ? capabilities : [];
  return { canSend: list.includes('sign'), canRevoke: list.includes('delivery_resend') };
}

export type LinkState = 'pending' | 'used' | 'revoked' | 'voided' | 'expired';
export type SigningLinkView = { id: string; estimateId: string; status: LinkState; createdAt: string; expiresAt: string };
export type DocumentLinkView = { id: string; set: 'homeowner' | 'adjuster'; status: 'active' | 'revoked' | 'expired'; createdAt: string; expiresAt: string };

const STATES = ['pending', 'used', 'revoked', 'voided', 'expired'];

export function signingLinkOf(body: unknown): SigningLinkView | null {
  const link = field(body, 'link');
  if (typeof field(link, 'id') !== 'string' || !STATES.includes(field(link, 'status') as string) || typeof field(link, 'expiresAt') !== 'string') return null;
  return link as SigningLinkView;
}

/** The document links answered with a signature (made at signing), each with its token, shown once. */
export function issuedLinksOf(body: unknown): { set: DocumentLinkView['set']; token: string }[] {
  const issued = field(body, 'documentLinks');
  if (!Array.isArray(issued)) return [];
  return issued.flatMap((entry) => {
    const set = field(field(entry, 'link'), 'set');
    const token = field(entry, 'token');
    return (set === 'homeowner' || set === 'adjuster') && typeof token === 'string' && TOKEN.test(token) ? [{ set, token }] : [];
  });
}

export function documentLinksOf(body: unknown): DocumentLinkView[] | null {
  const links = field(body, 'links');
  if (!Array.isArray(links)) return null;
  return links.filter((link) => typeof field(link, 'id') === 'string' && (field(link, 'set') === 'homeowner' || field(link, 'set') === 'adjuster')) as DocumentLinkView[];
}

/** The day a link stops working, in the phone's own time zone (or the one given). */
export function untilDay(iso: string, timeZone?: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', ...(timeZone ? { timeZone } : {}) }).format(when);
}

/** The technician's line about the job's signing link. */
export function signingLinkLine(link: SigningLinkView | null, timeZone?: string): string {
  if (!link) return 'No signing link has been made for this job.';
  switch (link.status) {
    case 'pending':
      return `A signing link is out. It works until ${untilDay(link.expiresAt, timeZone)}, until it is used, or until the estimate changes.`;
    case 'used':
      return 'The customer signed through the signing link.';
    case 'voided':
      return 'The estimate changed after the signing link was made, so it no longer works. Make a new link.';
    case 'revoked':
      return 'The signing link was revoked.';
    case 'expired':
      return 'The signing link expired. Make a new link.';
  }
}

export const SET_NAMES = { homeowner: "Homeowner's documents", adjuster: "Adjuster's documents" } as const;

export function documentLinkLine(link: DocumentLinkView, timeZone?: string): string {
  const name = SET_NAMES[link.set];
  if (link.status === 'active') return `${name}: works until ${untilDay(link.expiresAt, timeZone)}.`;
  return `${name}: ${link.status === 'revoked' ? 'revoked' : 'expired'}.`;
}

// --- The homeowner's and adjuster's pages ----------------------------------------------------------

export type LinkEstimate = {
  id: string;
  proposalSha256: string;
  proposal: Proposal;
  documents: { itemized_claim: Json[]; letter: string; photo_log: Json[]; claim: Json; compliance_notes: string[] };
};

export type SigningPage =
  | { status: 'pending'; companyName: string; expiresAt: string; estimate: LinkEstimate }
  | { status: 'signed'; companyName: string; viewUntil: string; agreement: SignedAgreement };

export function signingPageOf(body: unknown): SigningPage | null {
  const status = field(body, 'status');
  if (typeof field(body, 'companyName') !== 'string') return null;
  if (status === 'pending') {
    const estimate = field(body, 'estimate');
    if (typeof field(estimate, 'id') !== 'string' || typeof field(estimate, 'proposal') !== 'object' || typeof field(estimate, 'documents') !== 'object') return null;
    return body as SigningPage;
  }
  if (status === 'signed') {
    const agreement = field(body, 'agreement');
    if (typeof field(agreement, 'id') !== 'string' || typeof field(field(agreement, 'record'), 'proposal') !== 'object') return null;
    return body as SigningPage;
  }
  return null;
}

type Signed = { name: string; role?: SignerRole; signedAt: string; how: string };
export type DocumentsPage =
  | { set: 'homeowner'; companyName: string; expiresAt: string; signed: Signed; signatureSha256: string; proposalSha256: string; proposal: Proposal; photoLog: Json[] }
  | { set: 'adjuster'; companyName: string; expiresAt: string; signed: Signed; price: Proposal['price']; itemizedClaim: Json[]; letter: string; claim: Json };

export function documentsPageOf(body: unknown): DocumentsPage | null {
  const set = field(body, 'set');
  if (typeof field(body, 'companyName') !== 'string' || typeof field(field(body, 'signed'), 'name') !== 'string') return null;
  if (set === 'homeowner' && typeof field(body, 'proposal') === 'object' && Array.isArray(field(body, 'photoLog'))) return body as DocumentsPage;
  if (set === 'adjuster' && Array.isArray(field(body, 'itemizedClaim')) && typeof field(body, 'letter') === 'string') return body as DocumentsPage;
  return null;
}

export type PageNext = 'retry' | 'redraw' | 'done' | 'reload';

const NOT_AVAILABLE = 'This link is not available. It may have expired or been replaced. Ask your restoration company for a new link.';
const UNCONFIRMED = { message: 'We could not reach DryScope. Check your connection, then try again.', next: 'retry' } as const;

const PAGE_OUTCOMES: Record<string, { message: string; next: PageNext }> = {
  link_unavailable: { message: NOT_AVAILABLE, next: 'done' },
  link_voided: { message: 'This estimate was updated after the link was sent. Ask your restoration company for a new link.', next: 'done' },
  too_many_requests: { message: 'Too many tries in a short time. Wait a minute, then try again.', next: 'retry' },
  too_many_attempts: { message: 'This link has been tried too many times. Ask your restoration company for a new link.', next: 'done' },
  link_not_ready: { message: 'This estimate cannot be signed right now. Your restoration company has been asked to finish its settings; try again later.', next: 'retry' },
  already_signed: { message: 'This estimate is already signed. Reload the page to see the signed copy.', next: 'reload' },
  conflict: { message: 'This was already sent with other details. Clear the signature, draw it again, then sign.', next: 'redraw' },
  signature_missing: { message: 'The signature did not arrive. Draw it again, then sign.', next: 'redraw' },
  too_large: { message: 'The signature could not be read. Clear it, draw it again, then sign.', next: 'redraw' },
  unsupported_image: { message: 'The signature could not be read. Clear it, draw it again, then sign.', next: 'redraw' },
  invalid_request: { message: 'Check your name and both boxes, then sign again.', next: 'redraw' },
  links_unavailable: UNCONFIRMED,
};

/** The message and next step on the homeowner's or adjuster's page for a refused request. */
export function pageOutcomeOf(status: number, body: unknown): { message: string; next: PageNext } {
  const code = field(body, 'error');
  const known = typeof code === 'string' ? PAGE_OUTCOMES[code] : undefined;
  if (known) return known;
  if (status === 404) return PAGE_OUTCOMES.link_unavailable!;
  return status === 0 || status >= 500 ? UNCONFIRMED : { message: 'Something went wrong. Reload the page.', next: 'reload' };
}

// The two statements the homeowner ticks before signing through a link; the request carries both as
// `documentsConfirmed` and `electronicConsent`.
export const CONSENTS = {
  documents: 'I reviewed the proposal, the separate totals and the attached evidence.',
  electronic: 'I agree to sign electronically and to receive this signed record electronically. I can print or save a copy from this page.',
} as const;
