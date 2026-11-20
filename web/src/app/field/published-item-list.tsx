'use client';

import { useEffect, useState } from 'react';
import { companyAuth } from '@/lib/firebase-client';
import { readPublishedItemList } from '@/lib/field/api';
import type { User } from 'firebase/auth';
import { readItemList, replaceItemList, revokeItemList, type ItemList, type SavedList } from '@/lib/field/ds-prices';
import { ReopenTheApp } from '@/lib/field/idb';
import type { FieldSession } from '@/lib/field/session';
import { signInOf, stillSameSignIn, type SignIn } from '@/lib/field/sign-out';
import { itemUnitLabel } from './room-lists';

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const UPDATED = 'The older copy was updated.';
const NOT_SET = 'Prices not set';
const READING = 'Reading item list…';
const NEEDS_SIGNAL = 'Connect to get the published item list.';
const UNAVAILABLE = 'The item list could not be read. Try opening Check Scope again.';
const NOT_SAVED = 'This item list could not be saved on this phone.';
const CHECK_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 10_000;

type Display = { list: ItemList | null; notes: readonly string[] };
type Answer = { list: ItemList | null } | 'refused';

export function PublishedItemList({ session }: { session: FieldSession }) {
  const { companyId, user, capabilities, client } = session;
  if (!capabilities.includes('prices_read')) return null;
  return <PublishedList key={JSON.stringify([companyId, client.person.tenantId, user.uid])} session={session} />;
}

async function authTimeOf(user: User): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(NaN), TOKEN_TIMEOUT_MS);
  });
  return Promise.race([user.getIdTokenResult().then((token) => Date.parse(token.authTime), () => NaN), late]).finally(() => clearTimeout(timer));
}

function PublishedList({ session }: { session: FieldSession }) {
  const { companyId, client, online, offlineCapture, user } = session;
  const { person } = client;
  const { uid, tenantId } = person;
  const keep = offlineCapture && client.cache === 'persistent';
  const [display, setDisplay] = useState<Display>({ list: null, notes: [READING] });

  useEffect(() => {
    const owner = { companyId, tenantId, uid };
    const auth = companyAuth(person);
    let disposed = false;
    let loaded = false;
    // What the phone holds on disk (the last value that committed, or was read), the newest answer
    // the server gave this open view, and what is wrong with either. The screen renders the answer
    // when there is one, else the disk copy; a save only changes `saved` and `warning`.
    let saved: SavedList = null;
    let answer: Answer | null = null;
    let warning: string | null = null;
    let failure: string | null = null;
    let shownList: ItemList | null = null;
    let updated = false;
    let request: AbortController | null = null;
    let saving: Promise<void> = Promise.resolve();
    const signedIn = () => {
      const now = signInOf(auth.currentUser);
      return now.user?.uid === uid ? now : null;
    };

    function render() {
      if (disposed) return;
      const current = answer ?? saved;
      let next: Display;
      if (current === 'refused') next = { list: null, notes: [UNAVAILABLE] };
      else if (current) {
        const note = current.list ? warning ?? (updated ? UPDATED : null) : null;
        next = { list: current.list, notes: current.list ? (note ? [note] : []) : [NOT_SET, ...(warning ? [warning] : [])] };
      }
      else next = { list: null, notes: [failure ?? (loaded && !online ? NEEDS_SIGNAL : READING)] };
      setDisplay((before) => before.list?.versionId === next.list?.versionId && before.notes.join('\n') === next.notes.join('\n') ? before : next);
    }

    function save(mine: { list: ItemList | null }, from: SignIn, user: User) {
      const active = () => !disposed && stillSameSignIn(auth, from);
      saving = saving.then(async () => {
        if (answer !== mine || !active()) return;
        if (saved !== null && saved !== 'refused' && saved.list?.versionId === mine.list?.versionId) {
          warning = null;
          return render();
        }
        const authTime = await authTimeOf(user);
        let problem: string | null = null;
        const committed = await replaceItemList(owner, mine.list, authTime, active).catch((error: unknown) => {
          problem = error instanceof ReopenTheApp ? error.message : null;
          return false;
        });
        if (!active()) return;
        if (committed) saved = { list: mine.list };
        if (answer !== mine) return;
        warning = committed ? null : problem ?? NOT_SAVED;
        render();
      });
    }

    async function refresh() {
      const from = signedIn();
      if (!loaded || !online || !from?.user || request || document.visibilityState === 'hidden') return;
      const { user: current } = from;
      const sameSignIn = () => stillSameSignIn(auth, from);
      const pending = new AbortController();
      request = pending;
      const timeout = window.setTimeout(() => pending.abort(), REQUEST_TIMEOUT_MS);
      const stopped = new Promise<null>((resolve) => pending.signal.addEventListener('abort', () => resolve(null), { once: true }));
      let result: Awaited<ReturnType<typeof readPublishedItemList>> | null;
      try {
        result = await Promise.race([readPublishedItemList(current, pending.signal), stopped]);
      } finally {
        window.clearTimeout(timeout);
        request = null;
      }
      if (!sameSignIn()) return;
      if (!result || !result.ok) {
        if (result && (result.status === 403 || result.status === 404)) {
          answer = 'refused';
          shownList = null;
          warning = null;
          render();
          if (offlineCapture) await revokeItemList(owner, sameSignIn).then(() => { saved = 'refused'; }, () => undefined);
        } else {
          failure = UNAVAILABLE;
          render();
        }
        return;
      }

      const list = result.value.current;
      const mine = { list };
      updated = shownList !== null && list !== null && shownList.versionId !== list.versionId;
      shownList = list;
      answer = mine;
      failure = null;
      warning = null;
      render();
      if (keep) save(mine, from, current);
    }

    async function load() {
      const from = signedIn();
      if (!from) return;
      let read: SavedList = null;
      let problem: string | null = null;
      if (keep) {
        try {
          read = await readItemList(owner);
        } catch (error) {
          problem = error instanceof ReopenTheApp ? error.message : UNAVAILABLE;
        }
      }
      if (disposed) return;
      if (!stillSameSignIn(auth, from)) return void load();
      saved = read;
      failure = problem;
      shownList = read && read !== 'refused' ? read.list : null;
      loaded = true;
      render();
      void refresh();
    }

    void load();
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
  }, [companyId, keep, offlineCapture, online, person, tenantId, uid, user]);

  const { list, notes } = display;
  return (
    <section aria-label="Published item list" className="rounded-md border border-foreground/20 px-3">
      {list ? <ListContents list={list} /> : null}
      {notes.length > 0 ? <div role="status" className="py-2 text-sm">{notes.map((note) => <p key={note}>{note}</p>)}</div> : null}
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
