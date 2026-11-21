'use client';

import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { signedWhen } from '@/lib/agreements/screen';
import {
  dryingErrorCode,
  watchReceipt,
  watchView,
  type AvailableWatch,
  type WatchAction,
} from '@/lib/drying/client';
import { Outcome } from '../ui';
import { DryingConfirmation } from './confirmation';
import {
  dryingPath,
  dryingRequest,
  readFailure,
  useDryingRead,
  type DryingSession,
} from './requests';

const actions = [
  {
    action: 'mark_dry',
    permission: 'markDry',
    label: 'Mark dry',
    confirm: 'Confirm mark dry',
    help: 'This records that staff verified drying and ends monitoring.',
  },
  {
    action: 'extend',
    permission: 'extend',
    label: 'Extend plan',
    confirm: 'Confirm extension',
    help: 'This adds a note to monitoring. The signed drying days stay the same.',
  },
  {
    action: 'close',
    permission: 'close',
    label: 'Close monitoring',
    confirm: 'Confirm close monitoring',
    help: 'This ends drying monitoring. Job close is recorded separately.',
  },
] as const;

const statusText = {
  active: 'Monitoring active',
  dry_standard_met: 'Dry standard met',
  marked_dry: 'Marked dry',
  closed: 'Monitoring closed',
};
const trends = {
  stalled: 'Stalled across three recorded days',
  improving: 'Falling',
  recorded: 'Recorded',
};
const when = (value: string | null, fallback: string) => (value ? signedWhen(value) : fallback);

async function readWatch(user: DryingSession['user'], jobId: string, signal: AbortSignal) {
  const answer = await dryingRequest(user, `${dryingPath(jobId)}/drying-watch`, signal);
  const data = watchView.safeParse(answer.body).data;
  return answer.status === 200 && data?.jobId === jobId
    ? { kind: 'ready' as const, data }
    : readFailure(answer.status);
}

const roomMaterials = (watch: AvailableWatch, roomId: string | null) =>
  watch.materials.filter((material) => material.roomId === roomId);
// A room is covered only when it has an affected material reading and each has its dry standard.
const covered = (watch: AvailableWatch, roomId: string) => {
  const materials = roomMaterials(watch, roomId);
  return materials.length > 0 && materials.every((material) => material.dryStandard !== null);
};

function Facts({ watch }: { watch: AvailableWatch }) {
  const complete = watch.signedRooms.filter((room) => covered(watch, room.id)).length;
  return (
    <>
      <p className="font-medium">{statusText[watch.status]}</p>
      <ul className="list-disc space-y-1 pl-5">
        {watch.summary.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
        {complete !== watch.signedRooms.length - watch.missingRooms.length ? (
          <li>
            Only {complete} of {watch.signedRooms.length} signed rooms have every affected material
            reading with a dry standard.
          </li>
        ) : null}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Next reading due</dt>
        <dd>{when(watch.nextDueAt, 'No reading scheduled')}</dd>
        <dt>Last reading</dt>
        <dd>{when(watch.lastReadingAt, 'No readings yet')}</dd>
      </dl>
    </>
  );
}

function Rooms({ watch }: { watch: AvailableWatch }) {
  const name = (roomId: string | null) =>
    roomId === null
      ? 'Whole job'
      : (watch.signedRooms.find((room) => room.id === roomId)?.name ?? 'Other room');
  const listed = new Set(watch.roomReadings.map(({ roomId }) => roomId));
  const rows = [
    ...watch.roomReadings,
    ...watch.signedRooms
      .filter((room) => !listed.has(room.id))
      .map((room) => ({ roomId: room.id as string | null, lastReadingAt: null, overdue: false })),
  ];
  return (
    <>
      {watch.flags.includes('missing_dry_standard') ? (
        <p>Some affected materials still need a reading or a dry standard.</p>
      ) : null}
      {rows.length ? (
        <ul className="space-y-2" aria-label="Room reading status">
          {rows.map(({ roomId, lastReadingAt, overdue }) => {
            const materials = roomMaterials(watch, roomId);
            const signed = roomId !== null && watch.signedRooms.some((room) => room.id === roomId);
            return (
              <li key={roomId ?? ''}>
                <strong>{name(roomId)}</strong>
                <div>
                  {when(lastReadingAt, 'No reading yet')}
                  {overdue ? ' · Overdue' : ''}
                </div>
                {signed && materials.length === 0 ? (
                  <div>Missing affected material reading</div>
                ) : null}
                {materials.map((material, i) => (
                  <div key={i}>
                    {material.material}: {material.moisture} {material.unit} ·{' '}
                    {material.dryStandard === null
                      ? 'No dry standard'
                      : `Dry standard ${material.dryStandard} ${material.unit}`}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
      {watch.airTrends.length ? (
        <ul className="space-y-2" aria-label="Affected air trend">
          {watch.airTrends.map(({ roomId, trend }) => (
            <li key={roomId ?? ''}>
              <strong>{name(roomId)}</strong>
              <div>{trends[trend]}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {watch.air.map(({ roomId, firstGpp, latestGpp, referenceGpp }) => (
        <p key={roomId ?? ''}>
          {name(roomId)} affected air went from {firstGpp} to {latestGpp} grains/lb. Reference air
          is {referenceGpp} grains/lb.
        </p>
      ))}
    </>
  );
}

type Prompt = { action: (typeof actions)[number]; watch: AvailableWatch };
type ActionRequest = {
  id: string;
  action: WatchAction;
  factsHash: string;
  confirmed: true;
  reason: string;
};

export function DryingWatch({
  session,
  agreementId,
  changes,
}: {
  session: DryingSession;
  agreementId?: string;
  changes: number | string;
}) {
  const heading = useId();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const { result, refresh, setResult } = useDryingRead(session, true, readWatch, changes, true);
  const watch =
    !session.refused &&
    result.kind === 'ready' &&
    result.data.status !== 'unavailable' &&
    (!agreementId || result.data.agreementId === agreementId)
      ? result.data
      : null;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [draftReason, setDraftReason] = useState<{ action: WatchAction; reason: string } | null>(
    null,
  );
  const reason = draftReason?.action === prompt?.action.action ? (draftReason?.reason ?? '') : '';
  const [retries, setRetries] = useState<Partial<Record<WatchAction, ActionRequest>>>({});
  const retry = prompt ? (retries[prompt.action.action] ?? null) : null;
  const settle = (action: WatchAction) =>
    setRetries((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== action)),
    );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!session.visible) element?.close();
    return () => inFlight.current?.abort();
  }, [session.visible, session.isCurrent]);
  useLayoutEffect(() => {
    if (prompt && session.visible && !dialog.current?.open) dialog.current?.showModal();
  }, [prompt, session.visible]);
  useLayoutEffect(() => {
    if (
      prompt &&
      (session.refused ||
        result.kind === 'refused' ||
        (watch && watch.agreementId !== prompt.watch.agreementId))
    )
      dialog.current?.close();
  }, [prompt, result.kind, session.refused, watch]);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !prompt ||
      !session.online ||
      !watch ||
      !watch.can[prompt.action.permission] ||
      watch.agreementId !== prompt.watch.agreementId ||
      !session.isCurrent() ||
      inFlight.current
    )
      return;
    if (!reason.trim()) return setError('Enter a reason.');
    const payload: ActionRequest = retry ?? {
      id: crypto.randomUUID(),
      action: prompt.action.action,
      factsHash: prompt.watch.factsHash,
      confirmed: true,
      reason,
    };
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    setRetries((current) => ({ ...current, [payload.action]: payload }));
    const answer = await dryingRequest(
      session.user,
      `${dryingPath(session.jobId)}/drying-watch/actions`,
      controller.signal,
      payload,
    );
    inFlight.current = null;
    if (!session.isCurrent()) return;
    setBusy(false);
    if (controller.signal.aborted) return;
    const settled = payload.action;
    const receipt = watchReceipt.safeParse(answer.body).data?.receipt;
    if (
      (answer.status === 200 || answer.status === 201) &&
      receipt?.id === payload.id &&
      receipt.action === payload.action
    ) {
      settle(settled);
      setDraftReason(null);
      setNotice('Monitoring decision saved.');
      dialog.current?.close();
      refresh();
      return;
    }
    if (
      answer.status === 0 ||
      answer.status >= 500 ||
      (answer.status >= 200 && answer.status < 300)
    ) {
      setError(
        'Could not confirm that the monitoring decision was saved. Check your connection, then try again.',
      );
      return;
    }
    settle(settled);
    dialog.current?.close();
    const code = dryingErrorCode(answer.body);
    if ([401, 403, 404, 410].includes(answer.status)) {
      session.onRefused(answer.status, answer.status === 404);
      setResult({ kind: 'refused', status: answer.status });
      setError('Can’t save. Monitoring access changed.');
    } else if (code === 'stale_facts') {
      setError('Readings or monitoring facts changed. Review the updated watch and confirm again.');
      refresh();
    } else {
      setError(
        code === 'invalid_request'
          ? 'Can’t save. Check the reason and confirm again.'
          : 'Can’t save this monitoring decision. Read the current watch and try again.',
      );
      refresh();
    }
  }

  const unavailable =
    !session.refused && result.kind === 'ready' && result.data.status === 'unavailable';
  return (
    <section
      aria-labelledby={heading}
      hidden={session.blocked === true}
      className="min-w-0 flex-col gap-3 break-words rounded-md border border-input p-4 text-sm [&:not([hidden])]:flex"
    >
      <h3 id={heading} className="text-lg font-semibold">
        Drying watch
      </h3>
      {!session.online ? <p>Needs a connection</p> : null}
      {unavailable ? <p>No drying plan was saved with this signed job.</p> : null}
      {session.refused || result.kind === 'refused' ? (
        <p>Drying watch is unavailable for this job.</p>
      ) : null}
      {result.kind === 'loading' && session.online ? <p>Reading the drying watch…</p> : null}
      {result.kind === 'retry' || (result.kind === 'ready' && !unavailable && !watch) ? (
        <>
          <p>Could not read the drying watch.</p>
          <Button type="button" variant="outline" disabled={!session.online} onClick={refresh}>
            Try again
          </Button>
        </>
      ) : null}
      {watch ? (
        <>
          <Facts watch={watch} />
          <Rooms watch={watch} />
          {watch.decisions.length ? (
            <ul className="space-y-2" aria-label="Monitoring decisions">
              {watch.decisions.map((decision, i) => (
                <li key={i}>
                  <strong>{actions.find(({ action }) => action === decision.action)?.label}</strong>
                  <div>
                    {decision.by.displayName || 'Staff member'} · {signedWhen(decision.at)}
                  </div>
                  <p className="whitespace-pre-wrap">{decision.reason}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {actions
              .filter(({ permission }) => watch.can[permission])
              .map((action) => (
                <Button
                  key={action.action}
                  type="button"
                  variant="outline"
                  disabled={!session.online || busy}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setPrompt({ action, watch });
                  }}
                >
                  {action.label}
                </Button>
              ))}
          </div>
        </>
      ) : null}
      <Outcome error={prompt ? null : error} notice={notice} />
      {prompt ? (
        <DryingConfirmation
          ref={dialog}
          titleId={title}
          title={prompt.action.label}
          onClose={() => setPrompt(null)}
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <form onSubmit={confirm} className="flex flex-col gap-3 text-sm break-words">
            <p>{prompt.action.help}</p>
            <Facts watch={prompt.watch} />
            <Rooms watch={prompt.watch} />
            <label htmlFor={`${title}-reason`}>Reason</label>
            <textarea
              id={`${title}-reason`}
              className="min-h-20 w-full rounded-md border border-input p-2 text-base"
              required
              maxLength={500}
              value={reason}
              readOnly={busy || retry !== null}
              onChange={(event) =>
                setDraftReason({ action: prompt.action.action, reason: event.target.value })
              }
            />
            <Outcome error={error} notice={busy ? 'Saving…' : null} />
            <div className="flex flex-wrap gap-2">
              <Button
                autoFocus
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !session.online || !watch}>
                {retry ? 'Try again' : prompt.action.confirm}
              </Button>
            </div>
          </form>
        </DryingConfirmation>
      ) : null}
    </section>
  );
}
