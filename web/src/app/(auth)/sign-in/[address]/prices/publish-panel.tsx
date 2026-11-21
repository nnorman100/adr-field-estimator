'use client';

import type { User } from 'firebase/auth';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Table } from '@/engine/table';
import { appCheckHeaders } from '@/lib/app-check-client';
import { callApi } from '@/lib/firebase-client';
import { signInOf, type SignIn } from '@/lib/field/sign-out';
import { changed } from '@/lib/prices/edit';
import { moneyText, needsFreshSignIn, pricesMessage, readableDetail, workingCopyOf, type WorkingCopy } from '@/lib/prices/screen';
import { whileUpdateHeld } from '@/lib/update-activity';
import { CheckField, Hint, RadioGroup, Section, useBusy } from './ui';

// The owner's preview, publish, versions and price-list file, on the working copy as saved. Each
// call is the server's: the preview prices the built-in sample jobs there, publishing checks the
// table there and needs a sign-in under 15 minutes old, restore copies a version into the working
// copy, and the price-list file is read and written there.

type Common = {
  user: User;
  table: Table;
  working: WorkingCopy;
  dirty: boolean;
  lock: (on: boolean) => void;
  onWorkingCopy: (working: WorkingCopy) => void;
};

type SampleView = { id: string; name: string; summary: string; result: unknown };
type PreviewView = { publishCheck: { ok: boolean; error?: string }; zeroPrices: string[]; samples: SampleView[] };

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function previewOf(body: unknown): PreviewView | null {
  const check = field(body, 'publishCheck');
  const zero = field(body, 'zeroPrices');
  const samples = field(body, 'samples');
  if (typeof field(check, 'ok') !== 'boolean' || !Array.isArray(zero) || !Array.isArray(samples)) return null;
  return body as PreviewView;
}

function sampleTotal(result: unknown, table: Table): string {
  if (field(result, 'ok') !== true) {
    const error = field(result, 'error');
    return `Cannot be priced yet: ${typeof error === 'string' ? readableDetail(error, table) : 'a price is missing.'}`;
  }
  const totals = field(result, 'totals');
  const low = field(field(totals, 'low'), 'total');
  const high = field(field(totals, 'high'), 'total');
  if (typeof low !== 'string') return 'No total';
  return typeof high === 'string' && field(totals, 'mode') === 'range' ? `${moneyText(low)} to ${moneyText(high)}` : moneyText(low);
}

export function PreviewSection({
  user,
  table,
  dirty,
  unfinished,
  lock,
}: Pick<Common, 'user' | 'table' | 'dirty' | 'lock'> & { unfinished: boolean }) {
  // The answer with the prices it was for: once the prices on screen change, it is not shown.
  const [priced, setPriced] = useState<{ table: Table; view: PreviewView } | null>(null);
  const [busy, setBusy] = useBusy(lock);
  const [error, setError] = useState<string | null>(null);
  const preview = priced && !unfinished && !changed(priced.table, table) ? priced.view : null;
  async function run() {
    setBusy(true);
    setError(null);
    // The editor's open copy, saved or not: the preview writes nothing.
    const sent = table;
    const answer = await callApi(user, '/api/prices/preview', { method: 'POST', json: { table: sent } });
    setBusy(false);
    const view = answer.status === 200 ? previewOf(answer.body) : null;
    if (!view) return setError(pricesMessage(answer.status, answer.body, sent));
    setPriced({ table: sent, view });
  }
  return (
    <Section id="preview" title="Preview on sample jobs">
      <Hint>
        DryScope prices four made-up jobs with the prices on this screen{dirty ? ', including changes not saved yet' : ''}. Nothing is
        saved or published.
      </Hint>
      <Button type="button" variant="outline" disabled={busy || unfinished} onClick={() => void run()}>
        {busy ? 'Pricing the sample jobs…' : 'Price the sample jobs'}
      </Button>
      {unfinished ? <Hint>Correct the field marked &quot;Use a whole number&quot; first.</Hint> : null}
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {error ? <p className="text-red-800">{error}</p> : null}
        {preview ? (
          <>
            <p>
              {preview.publishCheck.ok
                ? 'These prices can be published.'
                : `Not ready to publish: ${readableDetail(preview.publishCheck.error ?? '', table)}`}
            </p>
            <ul className="flex flex-col gap-3">
              {preview.samples.map((sample) => (
                <li key={sample.id} className="rounded-md border border-foreground/20 p-3">
                  <p className="font-medium">{sample.name}</p>
                  <p className="text-sm text-foreground/75">{sample.summary}</p>
                  <p>{sampleTotal(sample.result, table)}</p>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Section>
  );
}

export function PublishSection({
  user,
  table,
  working,
  dirty,
  lock,
  published,
  onPublished,
  onSignInAgain,
}: Common & { published: boolean; onPublished: () => void; onSignInAgain: (from: SignIn) => void }) {
  // The check of the saved working copy, with the revision it checked: a later save, restore or
  // file makes it out of date, and the owner checks again.
  const [checked, setChecked] = useState<{ revision: number; view: PreviewView } | null>(null);
  const [reason, setReason] = useState('');
  const [range, setRange] = useState<'range' | 'single' | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  // The last publish sent and its key: only the very same publish, sent again, reuses the key.
  const [attempt, setAttempt] = useState<{ key: string; sent: string } | null>(null);
  const [busy, setBusy] = useBusy(lock);
  const [message, setMessage] = useState<string | null>(null);
  // The sign-in a publication was refused for with "sign in again": what the button ends.
  const [freshSignIn, setFreshSignIn] = useState<SignIn | null>(null);
  const names = new Map(table.items.map((item) => [item.item_id, item.name]));

  const check = checked?.revision === working.revision ? checked.view : null;

  async function start() {
    setBusy(true);
    setMessage(null);
    const revision = working.revision;
    const answer = await callApi(user, '/api/prices/preview', { method: 'POST', json: {} });
    setBusy(false);
    const view = answer.status === 200 ? previewOf(answer.body) : null;
    if (!view) return setMessage(pricesMessage(answer.status, answer.body, table));
    setChecked({ revision, view });
    setConfirmed([]);
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!published && range === null) return setMessage('Choose how estimates show the price.');
    setBusy(true);
    setMessage(null);
    setFreshSignIn(null);
    const request = {
      expectedRevision: working.revision,
      reason: reason.trim(),
      confirmZeroPrices: confirmed,
      ...(published || range === null ? {} : { rangeChoice: range }),
    };
    const sent = JSON.stringify(request);
    const publishKey = attempt?.sent === sent ? attempt.key : crypto.randomUUID();
    setAttempt({ key: publishKey, sent });
    const from = signInOf(user);
    const answer = await callApi(user, '/api/prices/publish', { method: 'POST', json: { ...request, publishKey } });
    setBusy(false);
    if (answer.status === 200 || answer.status === 201) {
      const sequence = field(field(answer.body, 'version'), 'sequence');
      setMessage(`Published as version ${typeof sequence === 'number' ? sequence : ''}. New estimates use these prices.`);
      setChecked(null);
      setReason('');
      setAttempt(null);
      onPublished();
      return;
    }
    if (needsFreshSignIn(answer.status, answer.body)) setFreshSignIn(from);
    setMessage(pricesMessage(answer.status, answer.body, table));
  }

  const reasonOk = Array.from(reason.trim()).length >= 3 && Array.from(reason.trim()).length <= 500;
  return (
    <Section id="publish" title="Publish">
      <Hint>
        Publishing makes these prices the next version. New estimates use the newest version; an estimate already priced keeps
        its version. Publishing needs a sign-in from the last 15 minutes.
      </Hint>
      {working.revision === 0 || dirty ? (
        <Hint>Save your changes before you publish.</Hint>
      ) : !check ? (
        <Button type="button" disabled={busy} onClick={() => void start()}>
          Check the prices before publishing
        </Button>
      ) : !check.publishCheck.ok && check.zeroPrices.length === 0 ? (
        <p>Not ready to publish: {readableDetail(check.publishCheck.error ?? '', table)}</p>
      ) : (
        <form onSubmit={(event) => void publish(event)} className="flex flex-col gap-4" aria-labelledby="publish-heading">
          {check.zeroPrices.length ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Confirm each $0.00 price</legend>
              {check.zeroPrices.map((id) => (
                <CheckField
                  key={id}
                  label={`${names.get(id) ?? id} is meant to cost $0.00`}
                  checked={confirmed.includes(id)}
                  onChange={(on) => setConfirmed((current) => (on ? [...current, id] : current.filter((other) => other !== id)))}
                />
              ))}
            </fieldset>
          ) : null}
          {published ? null : (
            <RadioGroup
              legend="Estimates show"
              name="first-range"
              value={range}
              options={[
                { value: 'range', label: 'A price range (low to high)' },
                { value: 'single', label: 'One price' },
              ]}
              hint="You can change this later in the estimate settings."
              onChange={setRange}
            />
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="publish-reason" className="text-sm font-medium">
              What changed (kept with the version)
            </label>
            <Input
              id="publish-reason"
              value={reason}
              maxLength={500}
              required
              autoComplete="off"
              enterKeyHint="done"
              aria-describedby="publish-reason-hint"
              onChange={(event) => setReason(event.target.value)}
            />
            <Hint id="publish-reason-hint">3 to 500 characters, for example &quot;First prices&quot;.</Hint>
          </div>
          <Button type="submit" disabled={busy || !reasonOk}>
            {busy ? 'Publishing…' : 'Publish these prices'}
          </Button>
        </form>
      )}
      <div role="status" aria-live="polite">
        {message ? <p>{message}</p> : null}
      </div>
      {freshSignIn ? (
        dirty ? (
          <Hint>Save your changes before you sign in again.</Hint>
        ) : (
          <Button type="button" variant="outline" onClick={() => onSignInAgain(freshSignIn)}>
            Sign in again
          </Button>
        )
      ) : null}
    </Section>
  );
}

type VersionRow = { id: string; sequence: number; reason: string; source: string; publishedAt: string };

function versionsOf(body: unknown): VersionRow[] | null {
  const versions = field(body, 'versions');
  if (!Array.isArray(versions)) return null;
  return versions.filter(
    (row): row is VersionRow =>
      typeof field(row, 'id') === 'string' && typeof field(row, 'sequence') === 'number' && typeof field(row, 'publishedAt') === 'string',
  );
}

const SOURCE: Record<string, string> = { restore: ' (a restored version)', import: ' (from a price-list file)', blank: '' };

export function VersionsSection({ user, table, working, lock, onWorkingCopy, refreshKey }: Common & { refreshKey: number }) {
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useBusy(lock);

  async function load() {
    setBusy(true);
    const answer = await callApi(user, '/api/prices/versions');
    setBusy(false);
    const rows = answer.status === 200 ? versionsOf(answer.body) : null;
    if (!rows) return setMessage(pricesMessage(answer.status, answer.body, table));
    setVersions(rows);
    setLoadedFor(refreshKey);
  }

  async function restore(id: string, sequence: number) {
    setBusy(true);
    setMessage(null);
    const answer = await callApi(user, `/api/prices/versions/${id}/restore`, { method: 'POST', json: { expectedRevision: working.revision } });
    setBusy(false);
    setAsking(null);
    const next = answer.status === 200 ? workingCopyOf(answer.body) : null;
    if (!next) return setMessage(pricesMessage(answer.status, answer.body, table));
    onWorkingCopy(next);
    setMessage(`Version ${sequence} is now the working copy. Nothing is published until you publish.`);
  }

  const stale = versions !== null && loadedFor !== refreshKey;
  return (
    <Section id="versions" title="Published versions">
      {versions === null || stale ? (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>
          Show the published versions
        </Button>
      ) : versions.length === 0 ? (
        <p>No version is published yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {versions.map((version) => (
            <li key={version.id} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
              <p className="font-medium">
                Version {version.sequence}
                {SOURCE[version.source] ?? ''}
              </p>
              <p className="text-sm">Published {new Date(version.publishedAt).toLocaleString()}</p>
              <p className="text-sm break-words">{version.reason}</p>
              {asking === version.id ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">This replaces the working copy, and any changes saved in it, with version {version.sequence}.</p>
                  <Button type="button" disabled={busy} onClick={() => void restore(version.id, version.sequence)}>
                    Restore version {version.sequence}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setAsking(null)}>
                    Keep the working copy
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" onClick={() => setAsking(version.id)}>
                  Copy version {version.sequence} into the working copy
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div role="status" aria-live="polite">
        {message ? <p>{message}</p> : null}
      </div>
    </Section>
  );
}

export function FileSection({ user, table, working, dirty, lock, onWorkingCopy }: Common) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useBusy(lock);

  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/prices/export', {
        headers: { Authorization: `Bearer ${token}`, ...(await appCheckHeaders()) },
        cache: 'no-store',
      });
      if (!response.ok) return setMessage(pricesMessage(response.status, await response.json().catch(() => null), table));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'price-list.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage(pricesMessage(0, null));
    } finally {
      setBusy(false);
    }
  }

  const upload = (file: File) => whileUpdateHeld('save', () => uploadFile(file));

  async function uploadFile(file: File) {
    setMessage(null);
    if (file.size > 1_500_000) return setMessage('That file is too large for a price list.');
    setBusy(true);
    let answer: Awaited<ReturnType<typeof callApi>>;
    try {
      const csv = await file.text();
      answer = await callApi(user, '/api/prices/import', { method: 'POST', json: { expectedRevision: working.revision, csv } });
    } catch {
      return setMessage('That file could not be read. Choose it again.');
    } finally {
      setBusy(false);
    }
    const next = answer.status === 200 ? workingCopyOf(field(answer.body, 'workingCopy')) : null;
    const count = field(answer.body, 'changed');
    if (!next || typeof count !== 'number') return setMessage(pricesMessage(answer.status, answer.body, table));
    onWorkingCopy(next);
    setMessage(count === 0 ? 'The file changed no price.' : `The file changed ${count} price${count === 1 ? '' : 's'} in the working copy.`);
  }

  return (
    <Section id="file" title="Price-list file">
      <Hint>
        Download the working copy&apos;s prices as a spreadsheet file (CSV), change the prices, and load it back. Loading a file
        changes prices only, never items or settings, and publishes nothing.
      </Hint>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void download()}>
        Download the price list
      </Button>
      {dirty ? (
        <Hint>Save your changes before you load a file.</Hint>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor="price-file" className="text-sm font-medium">
            Load a price-list file
          </label>
          <input
            id="price-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            className="min-h-11 text-base"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void upload(file);
            }}
          />
        </div>
      )}
      <div role="status" aria-live="polite">
        {message ? <p>{message}</p> : null}
      </div>
    </Section>
  );
}
