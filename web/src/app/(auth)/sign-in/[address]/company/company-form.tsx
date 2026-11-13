'use client';

import type { User } from 'firebase/auth';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { callApi } from '@/lib/firebase-client';
import { profileMessage, profileView } from '@/lib/profile/screen';
import type { ProfileView } from '@/lib/profile/service';
import { FocusedPanel } from '../../../focused-panel';

type Values = Pick<ProfileView, 'address' | 'phone' | 'email' | 'license' | 'signoff'>;

const valuesOf = ({ address, phone, email, license, signoff }: ProfileView): Values => ({
  address,
  phone,
  email,
  license,
  signoff,
});

// The owner's company settings on one screen at phone width: the lines the four documents print
// (letterhead and sign-off), and what is still missing before documents can be issued. One save
// sends the five lines; the screen then shows what the server holds. The company name is set by
// DryScope when the company is made, and the logo is a later step, so the letterhead is text.
export function CompanyForm({
  address: signInAddress,
  user,
  companyId,
  initial,
}: {
  address: string;
  user: User;
  companyId: string;
  initial: ProfileView;
}) {
  const [saved, setSaved] = useState<ProfileView>(initial);
  const [values, setValues] = useState<Values>(valuesOf(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (key: keyof Values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    setNotice(null);
  };

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await callApi(user, `/api/companies/${companyId}/profile`, {
        method: 'PUT',
        json: values,
      });
      const next = answer.status === 200 ? profileView(answer.body) : null;
      if (!next) return setError(profileMessage(answer.status, answer.body));
      setSaved(next);
      setValues(valuesOf(next));
      setNotice('Saved.');
    } finally {
      setBusy(false);
    }
  }

  const ready = saved.setupMissing.length === 0;

  return (
    <FocusedPanel title="Company settings">
      <p>
        <Link href={`/sign-in/${signInAddress}`} className="underline">
          Back to your sign-in page
        </Link>
      </p>

      <section
        aria-labelledby="setup-heading"
        className="flex flex-col gap-1 rounded-md border border-foreground/40 p-3"
      >
        <h2 id="setup-heading" className="font-semibold">
          {ready ? 'Ready to issue documents' : 'Still needed before documents'}
        </h2>
        {ready ? (
          <p>Your estimates, claims and letters can be issued with this letterhead.</p>
        ) : (
          <ul className="list-disc pl-5">
            {saved.setupMissing.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="flex flex-col gap-4"
        aria-labelledby="profile-heading"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id="profile-heading" className="text-lg font-semibold">
          Letterhead and sign-off
        </h2>

        <div className="flex flex-col gap-1">
          <span className="font-medium">Company name</span>
          <p>{saved.name}</p>
          <p className="text-sm">DryScope sets the company name when your company is created.</p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="profile-address" className="font-medium">
            Company address
          </label>
          <Input
            id="profile-address"
            name="address"
            type="text"
            maxLength={500}
            autoComplete="off"
            aria-describedby="profile-address-hint"
            value={values.address}
            onChange={set('address')}
          />
          <span id="profile-address-hint" className="text-sm">
            Street, city and ZIP on one line. Printed under the company name.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="profile-phone" className="font-medium">
            Company phone
          </label>
          <Input
            id="profile-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            maxLength={80}
            autoComplete="work tel"
            value={values.phone}
            onChange={set('phone')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="profile-email" className="font-medium">
            Company email
          </label>
          <Input
            id="profile-email"
            name="email"
            type="email"
            inputMode="email"
            maxLength={254}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="work email"
            value={values.email}
            onChange={set('email')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="profile-license" className="font-medium">
            CSLB license number
          </label>
          <Input
            id="profile-license"
            name="license"
            type="text"
            maxLength={80}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            aria-describedby="profile-license-hint"
            value={values.license}
            onChange={set('license')}
          />
          <span id="profile-license-hint" className="text-sm">
            Just the number, without “CSLB #”. The documents add that.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="profile-signoff" className="font-medium">
            Document sign-off
          </label>
          <Input
            id="profile-signoff"
            name="signoff"
            type="text"
            maxLength={150}
            autoComplete="off"
            aria-describedby="profile-signoff-hint"
            value={values.signoff}
            onChange={set('signoff')}
          />
          <span id="profile-signoff-hint" className="text-sm">
            The name printed under “Sincerely,” on the letter.
          </span>
        </div>

        <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
          {error ?? ''}
        </p>
        <p role="status" className="text-sm empty:hidden">
          {notice ?? ''}
        </p>
        <Button type="submit" disabled={busy}>
          Save company settings
        </Button>
      </form>
    </FocusedPanel>
  );
}
