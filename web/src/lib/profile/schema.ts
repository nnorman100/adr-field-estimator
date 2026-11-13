import { z } from 'zod';

// What the owner may change on the company profile (S5a-4): five lines of text the four documents
// print. The company's name is not here: the platform operator sets it when the company is made,
// and a body that names it (or anything else) is refused. Empty means not set.
//
// The limits are those migration 0010 holds as check constraints on the profile columns, and every
// rule here is as strict as the database's (or stricter), so a body that passes is never refused by
// the database. Text is trimmed first; a control character anywhere is refused, so a line cannot
// carry a line break into a letterhead.
export const PROFILE_FIELDS = ['address', 'phone', 'email', 'license', 'signoff'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

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

export const profileInput = z.strictObject({
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
});

export type ProfileInput = z.output<typeof profileInput>;
