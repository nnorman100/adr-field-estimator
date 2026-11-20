'use client';

import { useEffect, useState } from 'react';
import { companyAuth } from '@/lib/firebase-client';
import { readPublishedItemList } from '@/lib/field/api';
import { forgetItemList, readItemList, replaceItemList, type ItemList, type SavedList } from '@/lib/field/ds-prices';
import { ReopenTheApp } from '@/lib/field/idb';
import type { FieldSession } from '@/lib/field/session';
import { signInOf, stillSameSignIn } from '@/lib/field/sign-out';
import { itemUnitLabel } from './room-lists';

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const UPDATED = 'The older copy was updated.';
const NOT_SET = 'Prices not set';
const NEEDS_SIGNAL = 'Connect to get the published item list.';
const UNAVAILABLE = 'The item list could not be read. Try opening Check Scope again.';
const NOT_SAVED = 'This item list could not be saved on this phone.';
const CHECK_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type Display = { list: ItemList | null; note?: string };

export function PublishedItemList({ session }: { session: FieldSession }) {
  const { companyId, user, capabilities, client } = session;
  if (!capabilities.includes('prices_read')) return null;
  return <PublishedList key={JSON.stringify([companyId, client.person.tenantId, user.uid])} session={session} />;
}

function PublishedList({ session }: { session: FieldSession }) {
  const { companyId, client, online, offlineCapture, user } = session;
  const { person } = client;
  const { uid, tenantId } = person;
  const keep = offlineCapture && client.cache === 'persistent';
  const [display, setDisplay] = useState<Display>({ list: null, note: 'Reading item list…' });

  useEffect(() => {
    const owner = { companyId, tenantId, uid };
    const auth = companyAuth(person);
    let disposed = false;
    let cached: SavedList = null;
    let readFailure: string | null = null;
    let loaded = false;
    let request: AbortController | null = null;
    const signedIn = () => {
      const now = signInOf(auth.currentUser);
      return now.user?.uid === uid ? now : null;
    };
    const show = (list: ItemList | null, note?: string) => {
      setDisplay((before) => before.note === note && before.list?.versionId === list?.versionId ? before : { list, note });
    };
    const showSaved = (saved: NonNullable<SavedList>) => show(saved.list, saved.list ? undefined : NOT_SET);

    async function refresh() {
      const from = signedIn();
      if (!loaded || !online || !from?.user || request || document.visibilityState === 'hidden') return;
      const { user: current } = from;
      const active = () => !disposed && stillSameSignIn(auth, from);
      const pending = new AbortController();
      request = pending;
      const timeout = window.setTimeout(() => pending.abort(), REQUEST_TIMEOUT_MS);
      const stopped = new Promise<null>((resolve) => pending.signal.addEventListener('abort', () => resolve(null), { once: true }));
      const read = async () => {
        const answer = await readPublishedItemList(current, pending.signal);
        const authTime = keep && answer.ok ? await current.getIdTokenResult().then((token) => Date.parse(token.authTime), () => NaN) : NaN;
        return { answer, authTime };
      };
      try {
        const result = await Promise.race([read(), stopped]);
        if (!active()) return;
        const answer = result?.answer;
        if (!answer || !answer.ok) {
          if (answer?.denied) {
            cached = null;
            readFailure = null;
            if (keep) await forgetItemList(owner, active).catch(() => undefined);
            if (!active()) return;
          }
          if (!cached) show(null, readFailure ?? UNAVAILABLE);
          return;
        }

        const list = answer.value.current;
        const older = cached?.list != null && list !== null && list.versionId !== cached.list.versionId;
        if (older && cached) show(cached.list, 'This item list is out of date. Updating…');
        const changed = cached === null || cached.list?.versionId !== list?.versionId;
        let failure: string | null = null;
        if (keep && changed) {
          const saved = await replaceItemList(owner, list, result?.authTime ?? NaN, active).catch((error: unknown) => (error instanceof ReopenTheApp ? error : false));
          if (saved instanceof ReopenTheApp) failure = saved.message;
          else if (!saved) failure = NOT_SAVED;
        }
        if (!active()) return;
        if (!failure) {
          cached = keep ? { list } : null;
          readFailure = null;
        }
        if (!list) show(null, NOT_SET);
        else show(list, failure ?? (older ? UPDATED : undefined));
      } finally {
        window.clearTimeout(timeout);
        request = null;
      }
    }

    void (async () => {
      const saved = keep ? await readItemList(owner).catch((error: unknown) => {
        readFailure = error instanceof ReopenTheApp ? error.message : UNAVAILABLE;
        return null;
      }) : null;
      if (disposed || !signedIn()) return;
      cached = saved;
      loaded = true;
      if (saved) showSaved(saved);
      else if (readFailure) show(null, readFailure);
      else if (!online) show(null, NEEDS_SIGNAL);
      void refresh();
    })();
    const check = () => void refresh();
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', check);
    const timer = online ? window.setInterval(check, CHECK_INTERVAL_MS) : undefined;
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [companyId, keep, online, person, tenantId, uid, user]);

  const { list, note } = display;
  return (
    <section aria-label="Published item list" className="rounded-md border border-foreground/20 px-3">
      {list ? <ListContents list={list} /> : null}
      {note ? <p role="status" className="py-2 text-sm">{note}</p> : null}
    </section>
  );
}

function ListContents({ list }: { list: ItemList }) {
  const byId = new Map(list.items.map((item) => [item.itemId, item.name]));
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2.5 text-base font-medium">
        Item list as of <time dateTime={list.publishedAt}>{DATE.format(new Date(list.publishedAt))}</time>
      </summary>
      <div className="flex flex-col gap-3 pb-3 text-sm">
        <div>
          <h4 className="font-medium">Items</h4>
          <ul aria-label="Items" className="list-disc pe-1 ps-5 break-words">
            {list.items.map((item) => <li key={item.itemId}>{item.name} ({itemUnitLabel(item.unit)})</li>)}
          </ul>
        </div>
        <div>
          <h4 className="font-medium">Room types</h4>
          <ul aria-label="Room types" className="list-disc pe-1 ps-5 break-words">
            {list.roomTypes.map((room) => (
              <li key={room.id}>
                {room.name}
                {room.suggestedItemIds.length > 0 ? (
                  <ul aria-label={`Suggestions for ${room.name}`} className="list-disc ps-5">
                    {room.suggestedItemIds.map((id) => <li key={id}>{byId.get(id)}</li>)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
