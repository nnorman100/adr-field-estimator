'use client';

import type { User } from 'firebase/auth';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { callApi } from '@/lib/firebase-client';
import { draftOf, settingsOf, type DocumentsDraft } from '@/lib/profile/documents-draft';
import { changedProfile, profileMessage, profileView } from '@/lib/profile/screen';
import type { ProfileView } from '@/lib/profile/service';
import { FocusedPanel } from '../../../focused-panel';
import { AiUsageSection } from './ai-usage-section';
import { DocumentsSection } from './documents-section';

type Values = Pick<
  ProfileView,
  'address' | 'phone' | 'email' | 'license' | 'signoff' | 'emergencyPhone' | 'fax' | 'website' | 'tagline' | 'mailingAddress'
>;

const valuesOf = ({ address, phone, email, license, signoff, emergencyPhone, fax, website, tagline, mailingAddress }: ProfileView): Values => ({
  address,
  phone,
  email,
  license,
  signoff,
  emergencyPhone,
  fax,
  website,
  tagline,
  mailingAddress,
});

// The owner's company settings on one screen at phone width: the lines the four documents print
// (letterhead and sign-off), the document settings (S5a-4b), what is still missing before documents
// can be issued and signed, and the company's AI use today and this month (S7-4). One save sends
// every line and the settings with the revision they were read at; the screen then shows what the
// server holds, and when the profile changed elsewhere meanwhile, it shows that and says so. The
// company name is set by DryScope when the company is made, and the logo is a later step, so the
// letterhead is text.
export function CompanyForm({
  address: signInAddress,
  user,
  companyId,
  initial,
  showAiUsage,
  showPrices = false,
}: {
  address: string;
  user: User;
  companyId: string;
  initial: ProfileView;
  // Whether the role holds ai_usage_read (the owner): only then is the AI use asked for.
  showAiUsage: boolean;
  // Whether the company's prices are open (the price_books switch): only then is the Prices page linked.
  showPrices?: boolean;
}) {
  const [saved, setSaved] = useState<ProfileView>(initial);
  const [values, setValues] = useState<Values>(valuesOf(initial));
  const [documents, setDocuments] = useState<DocumentsDraft>(() => draftOf(initial.documents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (key: keyof Values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    setNotice(null);
  };
  const show = (view: ProfileView) => {
    setSaved(view);
    setValues(valuesOf(view));
    setDocuments(draftOf(view.documents));
  };

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await callApi(user, `/api/companies/${companyId}/profile`, {
        method: 'PUT',
        json: { ...values, documents: settingsOf(documents), revision: saved.revision, changeId: crypto.randomUUID() },
      });
      const current = changedProfile(answer.status, answer.body);
      if (current) show(current);
      const next = answer.status === 200 ? profileView(answer.body) : null;
      if (!next) return setError(profileMessage(answer.status, answer.body));
      show(next);
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
      {showPrices ? (
        <p>
          <a href={`/sign-in/${signInAddress}/prices`} className="underline">
            Prices
          </a>
        </p>
      ) : null}

      <section
        aria-labelledby="setup-heading"
        className="flex flex-col gap-1 rounded-md border border-foreground/40 p-3"
      >
        <h2 id="setup-heading" className="font-semibold">
          {ready ? 'Ready to issue and sign documents' : 'Still needed before documents can be issued and signed'}
        </h2>
        {ready ? (
          <p>
            Your estimates, claims and letters can be issued with this letterhead and signed with
            your authorization and payment terms.
          </p>
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
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
            value={values.signoff}
            onChange={set('signoff')}
          />
          <span id="profile-signoff-hint" className="text-sm">
            The name printed under “Sincerely,” on the letter.
          </span>
        </div>

        <LineField
          id="profile-emergency-phone"
          label="Emergency phone"
          hint="Printed on the letterhead when filled in. For example (555) 010-0199 for calls after hours."
          type="tel"
          maxLength={80}
          disabled={busy}
          value={values.emergencyPhone}
          onChange={set('emergencyPhone')}
        />
        <LineField
          id="profile-fax"
          label="Fax"
          hint="Printed on the letterhead when filled in. For example (555) 010-0102."
          type="tel"
          maxLength={80}
          disabled={busy}
          value={values.fax}
          onChange={set('fax')}
        />
        <LineField
          id="profile-website"
          label="Website"
          hint="Printed exactly as you type it. For example www.example.com."
          type="text"
          maxLength={200}
          disabled={busy}
          value={values.website}
          onChange={set('website')}
        />
        <LineField
          id="profile-tagline"
          label="Tagline"
          hint="A short line under the company name. For example “Water damage and mold remediation”."
          type="text"
          maxLength={150}
          disabled={busy}
          value={values.tagline}
          onChange={set('tagline')}
        />
        <LineField
          id="profile-mailing-address"
          label="Mailing address"
          hint="Only when mail goes somewhere other than the company address. For example PO Box 100, Testville, CA 90000."
          type="text"
          maxLength={500}
          disabled={busy}
          value={values.mailingAddress}
          onChange={set('mailingAddress')}
        />

        <DocumentsSection
          draft={documents}
          busy={busy}
          onChange={(next) => {
            setDocuments(next);
            setNotice(null);
          }}
        />

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

      {showAiUsage && <AiUsageSection user={user} companyId={companyId} />}
    </FocusedPanel>
  );
}

// One line of the letterhead with its label above and its example below.
function LineField({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint: string } & Pick<
  React.ComponentProps<'input'>,
  'type' | 'maxLength' | 'disabled' | 'value' | 'onChange'
>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <Input
        id={id}
        name={id}
        autoComplete="off"
        inputMode={input.type === 'tel' ? 'tel' : undefined}
        aria-describedby={`${id}-hint`}
        {...input}
      />
      <span id={`${id}-hint`} className="text-sm">
        {hint}
      </span>
    </div>
  );
}
