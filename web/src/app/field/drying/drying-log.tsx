'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { signedWhen } from '@/lib/agreements/screen';
import {
  createReceipt,
  dryingErrorCode,
  dryingRooms,
  readingsPage,
  voidReceipt,
  type Reading,
} from '@/lib/drying/client';
import type { ReadingInput } from '@/lib/drying/schema';
import { Outcome } from '../ui';
import { DryingConfirmation } from './confirmation';
import { patterns, ReadingForm, zones } from './reading-form';
import {
  accessRefused,
  dryingPath,
  dryingRequest,
  readFailure,
  useDryingRead,
  type DryingSession,
} from './requests';

async function readLog(user: DryingSession['user'], jobId: string, signal: AbortSignal) {
  const readings: Reading[] = [];
  let cursor: string | null = null;
  let canChange = false;
  // 400 active rows total and at most 200 per response.
  for (let page = 0; page < 2; page += 1) {
    const path = `${dryingPath(jobId)}/drying-readings?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const answer = await dryingRequest(user, path, signal);
    const data = readingsPage.safeParse(answer.body).data;
    if (answer.status !== 200 || data?.jobId !== jobId) return readFailure(answer.status);
    readings.push(...data.readings);
    canChange = data.canChange;
    cursor = data.next;
    if (!cursor) return { kind: 'ready' as const, data: { readings, canChange } };
  }
  return readFailure(0);
}

async function readRooms(user: DryingSession['user'], jobId: string, signal: AbortSignal) {
  const answer = await dryingRequest(user, `${dryingPath(jobId)}/drying-rooms`, signal);
  const data = dryingRooms.safeParse(answer.body).data;
  return answer.status === 200 && data?.jobId === jobId
    ? { kind: 'ready' as const, data: data.rooms }
    : readFailure(answer.status);
}

const errors: Record<string, string> = {
  invalid_request: 'Can’t save. Check the entered values and try again.',
  unknown_room:
    'Can’t save. That room is no longer available. Choose a current room and try again.',
  reading_limit: 'Can’t save. This job already has 400 active readings.',
  submission_in_progress:
    'Can’t save while this job is being submitted. Try again after it finishes.',
  conflict: 'Can’t save. This request already belongs to another reading.',
  reading_not_found: 'Can’t void. That reading is no longer available.',
  already_voided: 'That reading was already voided.',
};

function Measurement({ entry }: { entry: Reading }) {
  if (entry.kind === 'air') {
    const { air, reading } = entry;
    return (
      <>
        <p>
          {zones[reading.zone as keyof typeof zones]} air · {reading.temperatureF} °F ·{' '}
          {reading.relativeHumidity}% RH
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3">
          <dt>Humidity ratio</dt>
          <dd>{air.gpp} grains/lb</dd>
          <dt>Dew point</dt>
          <dd>{air.dewPointF} °F</dd>
          <dt>Dew-point depression</dt>
          <dd>{air.dewPointDepressionF} °F</dd>
          <dt>Vapor pressure</dt>
          <dd>{air.vaporPressureInhg} inHg</dd>
          <dt>Enthalpy</dt>
          <dd>{air.enthalpyBtuLb} Btu/lb</dd>
        </dl>
      </>
    );
  }
  if (entry.kind === 'material') {
    const { reading } = entry;
    return (
      <>
        <p>
          {reading.material} · {reading.affected ? 'Affected' : 'Unaffected'} · {reading.moisture}{' '}
          {reading.unit}
        </p>
        {reading.dryStandard !== null ? (
          <p>
            Dry standard {reading.dryStandard} {reading.unit}
          </p>
        ) : null}
      </>
    );
  }
  return (
    <>
      <p>
        {patterns[entry.reading.pattern as keyof typeof patterns]} · {entry.reading.deltaTF} Δ°F
      </p>
      {entry.reading.boundary ? (
        <p className="whitespace-pre-wrap">{entry.reading.boundary}</p>
      ) : null}
    </>
  );
}

function ReadingDetails({ entry }: { entry: Reading }) {
  const outside = entry.kind === 'air' && entry.reading.zone === 'outside';
  return (
    <>
      <p className="font-medium">
        {entry.roomLabel ?? (outside ? 'Outside' : 'Whole job')} ·{' '}
        <time dateTime={entry.takenAt}>{signedWhen(entry.takenAt)}</time>
      </p>
      <Measurement entry={entry} />
      {entry.reading.note ? <p className="whitespace-pre-wrap">{entry.reading.note}</p> : null}
    </>
  );
}

type PendingAdd = { reading: ReadingInput; accepted: () => void };
type PendingVoid = { entry: Reading; request: { changeId: string; expectedState: 'active' } };

export function DryingLog({
  session,
  onChanges,
}: {
  session: DryingSession;
  onChanges: () => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded && session.visible;
  const logSession = { ...session, visible };
  const log = useDryingRead(logSession, true, readLog);
  const rooms = useDryingRead(logSession, session.canAdd, readRooms);
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [voiding, setVoiding] = useState<PendingVoid | null>(null);
  const [formOpened, setFormOpened] = useState(false);
  const [busy, setBusy] = useState<'save' | 'void' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voidNotice, setVoidNotice] = useState<string | null>(null);
  const [retryVoid, setRetryVoid] = useState<PendingVoid | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const logData = log.result.kind === 'ready' ? log.result.data : null;
  const roomData = rooms.result.kind === 'ready' ? rooms.result.data : null;
  const refusal =
    session.refused ||
    log.result.kind === 'refused' ||
    (rooms.result.kind === 'refused' && session.canAdd);
  const canChange = session.canAdd && logData?.canChange === true && !refusal;
  const canEnter = canChange && roomData !== null;

  // Once offered, keep the same form mounted so a refusal or disconnect preserves the entry.
  if (canEnter && !formOpened) setFormOpened(true);
  const { onRefused } = session;
  useEffect(() => {
    if (refusal) onRefused();
  }, [refusal, onRefused]);
  useLayoutEffect(() => {
    if (!visible) dialog.current?.close();
    return () => inFlight.current?.abort();
  }, [visible, session.isCurrent]);
  useLayoutEffect(() => {
    if (voiding && visible && !dialog.current?.open) dialog.current?.showModal();
  }, [voiding, visible]);
  useLayoutEffect(() => {
    if (refusal) dialog.current?.close();
  }, [refusal]);

  async function write(path: string, payload: unknown, operation: 'save' | 'void') {
    if (!session.online || !visible || !session.isCurrent() || inFlight.current) return null;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(operation);
    const answer = await dryingRequest(session.user, path, controller.signal, payload);
    inFlight.current = null;
    if (!session.isCurrent()) return null;
    setBusy(null);
    return controller.signal.aborted ? null : answer;
  }

  function refuse(status: number) {
    session.onRefused();
    log.setResult({ kind: 'refused', status });
    rooms.setResult({ kind: 'refused', status });
  }

  async function save(pending: PendingAdd) {
    if (!canChange || inFlight.current || !session.online || !visible || !session.isCurrent()) return;
    setFormNotice(null);
    setFormError(null);
    setPendingAdd(pending);
    const answer = await write(
      `${dryingPath(session.jobId)}/drying-readings`,
      pending.reading,
      'save',
    );
    if (!answer) return;
    const receipt = createReceipt.safeParse(answer.body).data;
    if (
      (answer.status === 200 || answer.status === 201) &&
      receipt?.reading.id === pending.reading.id
    ) {
      setPendingAdd(null);
      pending.accepted();
      setFormNotice('Reading saved.');
      log.refresh();
      onChanges();
      return;
    }
    if (
      answer.status === 0 ||
      answer.status >= 500 ||
      (answer.status >= 200 && answer.status < 300)
    ) {
      setFormError(
        'Could not confirm that the reading was saved. Check your connection, then save again.',
      );
      return;
    }
    setPendingAdd(null);
    if (accessRefused(answer.status)) refuse(answer.status);
    const code = dryingErrorCode(answer.body) ?? '';
    setFormError(errors[code] ?? 'Can’t save this reading. Your entry is still here.');
    if (code === 'unknown_room') rooms.refresh();
  }

  async function voidReading(pending: PendingVoid) {
    if (!canChange || inFlight.current || !session.online || !visible || !session.isCurrent()) return;
    setVoidError(null);
    setVoidNotice(null);
    setRetryVoid(pending);
    const answer = await write(
      `${dryingPath(session.jobId)}/drying-readings/${encodeURIComponent(pending.entry.id)}/void`,
      pending.request,
      'void',
    );
    if (!answer) return;
    const receipt = voidReceipt.safeParse(answer.body).data?.void;
    if (
      answer.status === 200 &&
      receipt?.id === pending.entry.id &&
      receipt.changeId === pending.request.changeId
    ) {
      setRetryVoid(null);
      setVoidNotice('Reading voided.');
      dialog.current?.close();
      log.refresh();
      onChanges();
      return;
    }
    if (
      answer.status === 0 ||
      answer.status >= 500 ||
      (answer.status >= 200 && answer.status < 300)
    ) {
      setVoidError(
        'Could not confirm that the reading was voided. Check your connection, then try again.',
      );
      return;
    }
    setRetryVoid(null);
    const code = dryingErrorCode(answer.body) ?? '';
    if (accessRefused(answer.status) && code !== 'reading_not_found') refuse(answer.status);
    else log.refresh();
    setVoidError(errors[code] ?? 'Can’t void this reading.');
    dialog.current?.close();
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        Drying log
      </Button>
      <section
        id={id}
        aria-label="Drying log"
        hidden={!expanded}
        className="min-w-0 flex-col gap-4 break-words rounded-md border border-input p-4 text-sm [&:not([hidden])]:flex"
      >
        {refusal ? <p>Drying readings are unavailable for this job.</p> : null}
        {log.result.kind === 'loading' && session.online ? <p>Reading the drying log…</p> : null}
        {!session.online && !formOpened ? <p>Needs a connection</p> : null}
        {log.result.kind === 'retry' ? (
          <div>
            <p>Could not read the drying log.</p>
            <Button
              type="button"
              variant="outline"
              onClick={log.refresh}
              disabled={!session.online}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {!refusal && logData ? (
          <>
            {session.office ? <p>Read only.</p> : null}
            {logData.readings.length ? (
              <ol className="divide-y divide-input">
                {logData.readings.map((entry) => (
                  <li key={entry.id} className="flex min-w-0 flex-col items-start gap-1 py-3">
                    <ReadingDetails entry={entry} />
                    {canChange ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          busy !== null ||
                          !session.online ||
                          (retryVoid !== null && retryVoid.entry.id !== entry.id)
                        }
                        onClick={() => {
                          setVoidError(null);
                          setVoidNotice(null);
                          setVoiding(
                            retryVoid ?? {
                              entry,
                              request: { changeId: crypto.randomUUID(), expectedState: 'active' },
                            },
                          );
                        }}
                      >
                        Void reading
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No readings yet.</p>
            )}
          </>
        ) : null}
        <Outcome notice={voidNotice} error={voiding ? null : voidError} />
        {rooms.result.kind === 'retry' && !refusal && session.canAdd ? (
          <div>
            <p>Could not read the room list.</p>
            <Button
              type="button"
              variant="outline"
              disabled={!session.online}
              onClick={rooms.refresh}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {formOpened ? (
          <ReadingForm
            rooms={!refusal && session.canAdd ? (roomData ?? []) : []}
            busy={busy === 'save'}
            pending={pendingAdd !== null}
            online={session.online}
            locked={!canChange || busy === 'void'}
            error={formError}
            notice={formNotice}
            submit={(reading, accepted) => void save({ reading, accepted })}
            saveAgain={() => pendingAdd && void save(pendingAdd)}
          />
        ) : null}
        {voiding && !refusal ? (
          <DryingConfirmation
            ref={dialog}
            titleId={`${id}-void`}
            title="Void this reading?"
            onClose={() => setVoiding(null)}
            onCancel={(event) => {
              if (busy === 'void') event.preventDefault();
            }}
          >
            <div className="flex flex-col gap-3 text-sm break-words">
              <ReadingDetails entry={voiding.entry} />
              <p>This removes the reading from the active log and updates the drying watch.</p>
              <Outcome notice={busy === 'void' ? 'Saving…' : null} error={voidError} />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  autoFocus
                  variant="outline"
                  disabled={busy === 'void'}
                  onClick={() => dialog.current?.close()}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy === 'void' || !session.online}
                  onClick={() => void voidReading(voiding)}
                >
                  {retryVoid ? 'Try again' : 'Void reading'}
                </Button>
              </div>
            </div>
          </DryingConfirmation>
        ) : null}
      </section>
    </div>
  );
}
