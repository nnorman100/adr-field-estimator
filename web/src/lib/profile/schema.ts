import { z } from 'zod';
import { documentSettings } from './settings';

// What the owner may change on the company profile (S5a-4): five lines of text the four documents
// print, and since S5a-4b five more letterhead lines and the document settings. The company's name is not here: the platform operator sets it when the company is made,
// and a body that names it (or anything else) is refused. Empty means not set.
//
// The limits are those migrations 0010 and 0013 hold as check constraints on the profile columns, and every
// rule here is as strict as the database's (or stricter), so a body that passes is never refused by
// the database. Text is trimmed first; a control character anywhere is refused, so a line cannot
// carry a line break into a letterhead.
export const PROFILE_FIELDS = ['address', 'phone', 'email', 'license', 'signoff'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

// S5a-4b's letterhead lines (migration 0013), printed on the letterhead when set, and its document
// settings (src/lib/profile/settings.ts). A save may leave any of these out, and one left out keeps
// what is stored, so a screen that does not know them yet cannot clear them; `documents`, when
// sent, is the whole settings object (a setting left out of it is its neutral default).
export const LETTERHEAD_FIELDS = ['emergencyPhone', 'fax', 'website', 'tagline', 'mailingAddress'] as const;
export type LetterheadField = (typeof LETTERHEAD_FIELDS)[number];

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// A printable ASCII address with one @ and a dot in the domain, as the database's check reads it.
const EMAIL = /^[!-~]+$/;
const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !CONTROL.test(value));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The profile's revision: the company row's updated_at as the server sends it (UTC, microseconds).
export const PROFILE_REVISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// `revision` is the one the screen last read; `changeId` is this change's own id, made on the phone.
export const profileInput = z.strictObject({
  revision: z.string().regex(PROFILE_REVISION),
  changeId: z
    .string()
    .regex(UUID)
    .transform((value) => value.toLowerCase()),
  address: line(500),
  phone: line(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((value) => value === '' || (EMAIL.test(value) && EMAIL_SHAPE.test(value))),
  license: line(80),
  signoff: line(150),
  emergencyPhone: line(80).optional(),
  fax: line(80).optional(),
  website: line(200).optional(),
  tagline: line(150).optional(),
  mailingAddress: line(500).optional(),
  documents: documentSettings.optional(),
});

export type ProfileInput = z.output<typeof profileInput>;
export type ProfileValues = Pick<ProfileInput, ProfileField>;
export type LetterheadValues = Required<Pick<ProfileInput, LetterheadField>>;
