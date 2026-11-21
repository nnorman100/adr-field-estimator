'use client';

import type { User } from 'firebase/auth';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Table } from '@/engine/table';
import { callApi } from '@/lib/firebase-client';
import type { SignIn } from '@/lib/field/sign-out';
import { changed, updateItem } from '@/lib/prices/edit';
import { pricesMessage, pricesView, workingCopyOf, type CurrentVersion, type WorkingCopy } from '@/lib/prices/screen';
import { ItemCard } from './item-card';
import { ItemsByHeading } from './price-list';
import { FileSection, PreviewSection, PublishSection, VersionsSection } from './publish-panel';
import { RoomPays } from './room-pays';
import { AdjustmentsSection } from './adjustments-section';
import { HeadingsSection, RoomTypesSection, SettingsSection, SizesSection } from './settings-sections';
import { Hint, Section, WholeFieldCheck, useBusy } from './ui';

// The owner's Prices page: the working copy open for editing, saved whole with the revision it was
// read at, then previewed, published, restored from a version or filled from a price-list file.
// The screen holds the copy as the server parsed it and sends it back whole; the server parses it
// again and refuses anything wrong with a sentence naming the item.

export function PricesEditor({
  user,
  initialWorking,
  initialCurrent,
  onSignInAgain,
}: {
  user: User;
  initialWorking: WorkingCopy;
  initialCurrent: CurrentVersion | null;
  onSignInAgain: (from: SignIn) => void;
}) {
  const [saved, setSaved] = useState<WorkingCopy>(initialWorking);
  const [draft, setDraft] = useState<Table>(initialWorking.table);
  const [current, setCurrent] = useState<CurrentVersion | null>(initialCurrent);
  // While any request of this page is out, every field and button is locked, so nothing typed
  // meanwhile is replaced by the answer.
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useBusy(setLocked);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [published, setPublished] = useState(0);
  const [undone, setUndone] = useState(0);
  const [badFields, setBadFields] = useState<ReadonlySet<string>>(() => new Set());
  const checkField = useCallback(
    (id: string, ok: boolean) =>
      setBadFields((bad) => {
        if (ok !== bad.has(id)) return bad;
        const next = new Set(bad);
        if (ok) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const unfinished = badFields.size > 0;
  const dirty = changed(saved.table, draft) || unfinished;

  // Leaving the page with changes not saved asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = (table: Table) => {
    setDraft(table);
    setMessage(null);
  };
  const take = (working: WorkingCopy) => {
    setSaved(working);
    setDraft(working.table);
  };

  async function save() {
    setBusy(true);
    setMessage(null);
    const answer = await callApi(user, '/api/prices/working-copy', {
      method: 'PUT',
      json: { expectedRevision: saved.revision, table: draft },
    });
    setBusy(false);
    const next = answer.status === 200 ? workingCopyOf(answer.body) : null;
    if (next) {
      take(next);
      return setMessage('Saved. The prices are not published until you publish them.');
    }
    if (answer.status === 409) setStale(true);
    setMessage(pricesMessage(answer.status, answer.body, draft));
  }

  async function reload() {
    setBusy(true);
    const answer = await callApi(user, '/api/prices');
    setBusy(false);
    const view = answer.status === 200 ? pricesView(answer.body) : null;
    if (!view || view.view !== 'owner') return setMessage(pricesMessage(answer.status, answer.body));
    take(view.workingCopy);
    setCurrent(view.current);
    setStale(false);
    setMessage(null);
  }

  const common = { user, table: draft, working: saved, dirty, lock: setLocked, onWorkingCopy: take };
  return (
    <fieldset disabled={locked} aria-busy={locked} className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p role="status">
          {current
            ? `Estimates use version ${current.sequence}, published ${new Date(current.publishedAt).toLocaleDateString()}.`
            : 'No prices are published yet, so no estimate can be priced. Set your prices, then publish them.'}
        </p>
        <Hint>
          DryScope supplies no prices: every price here is yours. You are editing the working copy; estimates change only when you
          publish.
        </Hint>
        <nav aria-label="Parts of this page">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-base underline">
            <li><a href="#items">Items</a></li>
            <li><a href="#room-pays">What does this room pay?</a></li>
            <li><a href="#settings">Settings</a></li>
            <li><a href="#publish">Publish</a></li>
            <li><a href="#versions">Versions</a></li>
          </ul>
        </nav>
      </div>
      <WholeFieldCheck.Provider value={checkField}>
      <Fragment key={undone}>
      <Section id="items" title="Items">
        <Hint>Open an item to set its price. Each item has one price until you turn on &quot;Price varies by water category&quot;.</Hint>
        <ItemsByHeading
          table={draft}
          items={draft.items}
          render={(item) => (
            <ItemCard table={draft} item={item} onChange={(next) => edit(updateItem(draft, item.item_id, () => next))} />
          )}
        />
      </Section>
      <RoomPays table={draft} unfinished={unfinished} />
      <SettingsSection table={draft} onChange={edit} published={current !== null} />
      <SizesSection table={draft} onChange={edit} />
      <HeadingsSection table={draft} onChange={edit} />
      <RoomTypesSection table={draft} onChange={edit} />
      <AdjustmentsSection table={draft} onChange={edit} />
      </Fragment>
      </WholeFieldCheck.Provider>
      <PreviewSection user={user} table={draft} dirty={dirty} unfinished={unfinished} lock={setLocked} />
      <PublishSection
        {...common}
        published={current !== null}
        onSignInAgain={onSignInAgain}
        onPublished={() => {
          setPublished((count) => count + 1);
          void reload();
        }}
      />
      <VersionsSection {...common} refreshKey={published} />
      <FileSection {...common} />
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-foreground/20 bg-background px-4 py-3">
        <div role="status" aria-live="polite">
          {unfinished ? (
            <p>A field marked &quot;Use a whole number&quot; holds something else. Correct it before you save or publish.</p>
          ) : message ? (
            <p>{message}</p>
          ) : dirty ? (
            <p>You have changes that are not saved.</p>
          ) : (
            <p>All changes are saved.</p>
          )}
        </div>
        {stale ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
            Reload the saved prices
          </Button>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" className="flex-1" disabled={busy || !dirty || unfinished} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !dirty}
            onClick={() => {
              edit(saved.table);
              setUndone((count) => count + 1);
            }}
          >
            Undo changes
          </Button>
        </div>
      </div>
    </fieldset>
  );
}
