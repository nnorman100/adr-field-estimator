'use client';

import { useEffect, useRef, useState } from 'react';
import { companyAuth } from '@/lib/firebase-client';
import { readPublishedItemList } from '@/lib/field/api';
import type { User } from 'firebase/auth';
import {
  eraseItemList,
  governing,
  onRefusalElsewhere,
  readItemList,
  refusedSince,
  replaceItemList,
  requestStamp,
  unchanged,
  type ItemList,
  type SavedList,
  type Stamp,
} from '@/lib/field/ds-prices';
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

// What one open view knows. It outlives the effect below, which restarts when the connection
// changes. `answer` is the newest the server gave this view (a list, no list, or a refusal) and
// `saved` what the phone holds; the screen shows the answer when there is one and the saved copy
// otherwise. A save changes only `saved` and `warning`. `stamp` is the time what is shown was asked
// for: a refusal recorded since, in any tab, hides it.
type View = {
  loaded: boolean;
  online: boolean;
  saved: SavedList;
  answer: Answer | null;
  warning: string | null;
  readProblem: string | null;
  fetchProblem: string | null;
  shownList: ItemList | null;
  updated: boolean;
  saving: Promise<void>;
  stamp: Stamp | null;
};

function display(view: View): Display {
  const current = view.answer ?? view.saved;
  if (typeof current === 'string') return { list: null, notes: [UNAVAILABLE] };
  if (!current) return { list: null, notes: [view.readProblem ?? view.fetchProblem ?? (view.loaded && !view.online ? NEEDS_SIGNAL : READING)] };
  if (!current.list) return { list: null, notes: [NOT_SET, ...(view.warning ? [view.warning] : [])] };
  const note = view.warning ?? (view.updated ? UPDATED : null);
  return { list: current.list, notes: note ? [note] : [] };
}

// The 403 codes the server gives when the person, their account, the role or the company no longer
// allows the list: the route's capability check (`not_allowed`) and the member route's identity
// check (src/lib/auth/identity.ts, REFUSALS). A 403 or 404 from a captive portal or a proxy carries
// none of them and is no answer.
const ACCESS_REFUSALS = new Set([
  'not_allowed', 'not_a_member', 'member_disabled', 'company_inactive', 'account_disabled', 'email_unverified', 'no_tenant', 'unknown_tenant',
]);

// What a refusal from the item-list route means for the copy on this phone. 'erase': the person may
// no longer see this company's list. 'hide': the sign-in must be renewed, or completed with the
// role's second step; the list is hidden now and the copy kept for after it.
function refusalOf({ status, code }: { status: number; code?: string }): 'erase' | 'hide' | null {
  if (code === undefined) return null;
  if ((status === 403 && ACCESS_REFUSALS.has(code)) || (status === 404 && code === 'not_found') || (status === 401 && code === 'sign_in_revoked')) return 'erase';
  if ((status === 401 && code === 'sign_in_again') || (status === 403 && code === 'second_step_required')) return 'hide';
  return null;
}

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
  const [shown, setShown] = useState<Display>({ list: null, notes: [READING] });
  const mounted = useRef(true);
  const open = useRef<View>({
    loaded: false, online, saved: null, answer: null, warning: null, readProblem: null, fetchProblem: null,
    shownList: null, updated: false, saving: Promise.resolve(), stamp: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const view = open.current;
    view.online = online;
    const owner = { companyId, tenantId, uid };
    const auth = companyAuth(person);
    let disposed = false;
    let request: AbortController | null = null;
    const signedIn = () => {
      const now = signInOf(auth.currentUser);
      return now.user?.uid === uid ? now : null;
    };

    function render() {
      if (!mounted.current) return;
      const next = display(view);
      setShown((before) => before.list?.versionId === next.list?.versionId && before.notes.join('\n') === next.notes.join('\n') ? before : next);
    }

    // Hides what this view shows when a refusal has been recorded since it was asked for, in this
    // tab or another. The tab that received the refusal erases the copy; a reload reads the refusal times
    // and shows nothing the refusal covers (ds-prices.ts).
    function hideIfRefused() {
      if (view.stamp === null || !refusedSince(owner, view.stamp)) return;
      view.stamp = null;
      // Only what is shown is hidden: an answer asked for since the refusal still comes in, and a
      // save of an older one is refused by its own stamp check (ds-prices.ts).
      view.answer = 'refused';
      view.shownList = null;
      view.warning = null;
      render();
    }

    function save(mine: { list: ItemList | null }, stamp: Stamp, governs: () => boolean, from: SignIn, signedInUser: User) {
      const active = () => governs() && stillSameSignIn(auth, from);
      view.saving = view.saving.then(async () => {
        if (!active()) return;
        const authTime = await authTimeOf(signedInUser);
        let problem: string | null = null;
        const committed = await replaceItemList(owner, mine.list, authTime, stamp, active).catch((error: unknown) => {
          problem = error instanceof ReopenTheApp ? error.message : null;
          return false;
        });
        if (!governs()) return;
        if (committed) view.saved = { list: mine.list };
        else if (!active()) return;
        view.warning = committed ? null : problem ?? NOT_SAVED;
        render();
      });
    }

    async function refresh() {
      const from = signedIn();
      if (!view.loaded || !online || !from?.user || request || document.visibilityState === 'hidden') return;
      const { user: current } = from;
      const sameSignIn = () => stillSameSignIn(auth, from);
      const pending = new AbortController();
      request = pending;
      // When this answer was asked for: it is shown and saved only while no refusal came since
      // (ds-prices.ts).
      const stamp = requestStamp();
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
      if (!result?.ok) {
        const refusal = result ? refusalOf(result) : null;
        if (refusal) {
          // A save still queued for an earlier answer of this view is dropped.
          governing(owner);
          view.answer = 'refused';
          view.shownList = null;
          view.warning = null;
          render();
          if (refusal === 'erase') {
            view.saved = null;
            // Also on a phone that now keeps nothing: one that kept a copy earlier still holds it.
            void eraseItemList(owner);
          }
        } else {
          view.fetchProblem = UNAVAILABLE;
          render();
        }
        return;
      }

      const governs = governing(owner);
      // An answer is dropped when a refusal was recorded after its request started.
      if (!(await unchanged(owner, stamp).catch(() => false)) || !governs() || !sameSignIn()) return;
      const list = result.value.current;
      const before = view.answer;
      if (!before || before === 'refused' || before.list?.versionId !== list?.versionId) view.warning = null;
      view.updated = view.shownList !== null && list !== null && view.shownList.versionId !== list.versionId;
      view.shownList = list;
      view.stamp = stamp;
      view.fetchProblem = null;
      view.readProblem = null;
      const mine = { list };
      view.answer = mine;
      render();
      if (keep) save(mine, stamp, governs, from, current);
    }

    async function load(): Promise<void> {
      if (view.answer === null) {
        const from = signedIn();
        if (!from) return;
        let read: SavedList = null;
        let problem: string | null = null;
        const stamp = requestStamp();
        if (keep) {
          try {
            read = await readItemList(owner);
          } catch (error) {
            problem = error instanceof ReopenTheApp ? error.message : UNAVAILABLE;
          }
        }
        if (disposed) return;
        if (!stillSameSignIn(auth, from)) return load();
        if (view.answer === null) {
          view.saved = read;
          view.readProblem = problem;
          view.shownList = read && read !== 'withheld' ? read.list : null;
          view.stamp = stamp;
          // A refusal recorded while the copy was read.
          hideIfRefused();
        }
      }
      view.loaded = true;
      render();
      void refresh();
    }

    void load();
    const check = () => {
      // Back from the back-forward cache or the background, where another tab's refusal may not
      // have reached this page.
      hideIfRefused();
      void refresh();
    };
    const stopWatching = onRefusalElsewhere(owner, hideIfRefused);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', check);
    const timer = online ? window.setInterval(check, CHECK_INTERVAL_MS) : undefined;
    return () => {
      disposed = true;
      stopWatching();
      request?.abort();
      window.clearInterval(timer);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [companyId, keep, offlineCapture, online, person, tenantId, uid, user]);

  const { list, notes } = shown;
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
