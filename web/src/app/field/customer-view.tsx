'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { saveClaim, saveCustomer, type Answer, type JobDetail } from '@/lib/field/api';
import { pending, usePending, type RecordKind } from '@/lib/field/pending';
import type { JobContext } from './job-screens';
import { Box, Outcome, Section } from './ui';

type CustomerJob = JobContext & { detail: JobDetail };

type Values = Record<string, string>;
type BoxSpec = { key: string; label: string; type?: 'email' | 'tel' | 'date'; autoComplete?: string; inputMode?: 'decimal' };

const CUSTOMER: BoxSpec[] = [
  { key: 'name', label: 'Customer name', autoComplete: 'name' },
  { key: 'phone', label: 'Customer phone', type: 'tel', autoComplete: 'tel' },
  { key: 'email', label: 'Customer email', type: 'email', autoComplete: 'email' },
  { key: 'propertyAddress', label: 'Property address', autoComplete: 'street-address' },
];

const CLAIM: BoxSpec[] = [
  { key: 'carrier', label: 'Insurance carrier' },
  { key: 'claimNumber', label: 'Claim number' },
  { key: 'policyNumber', label: 'Policy number' },
  { key: 'dateOfLoss', label: 'Date of loss', type: 'date' },
  { key: 'lossCause', label: 'Cause of loss' },
  { key: 'adjusterName', label: 'Adjuster name' },
  { key: 'adjusterEmail', label: 'Adjuster email', type: 'email' },
  { key: 'adjusterPhone', label: 'Adjuster phone', type: 'tel' },
  { key: 'deductible', label: 'Deductible' },
];

const customerOf = (detail: JobDetail): Values => ({ ...detail.customer, propertyAddress: detail.job.propertyAddress });
const claimOf = (detail: JobDetail): Values => ({ ...detail.claim, dateOfLoss: detail.claim.dateOfLoss ?? '' });

// Customer and claim (S5a-6), saved to the jobs API (S5a-3), which keeps them in the database. Who
// may save follows owner decision J3: the estimator who owns the field work, the owner and office,
// while the job is unsigned; the server decides, and its refusal is shown.
export function CustomerView({ job }: { job: CustomerJob }) {
  const canSave = job.session.capabilities.some((key) => key === 'scope' || key === 'coordination');
  return (
    <div className="flex flex-col gap-4">
      <h3 className="sr-only">Customer and claim</h3>
      <RecordForm
        job={job}
        title="Customer"
        kind="customer"
        boxes={CUSTOMER}
        readOnly={!canSave}
        send={(values, revision, changeId) =>
          saveCustomer(job.session.user, job.detail.job.id, {
            name: values.name!,
            phone: values.phone!,
            email: values.email!,
            propertyAddress: values.propertyAddress!,
            revision,
            changeId,
          })
        }
        reread={customerOf}
      />
      <RecordForm
        job={job}
        title="Claim"
        kind="claim"
        boxes={CLAIM}
        readOnly={!canSave}
        send={(values, revision, changeId) =>
          saveClaim(job.session.user, job.detail.job.id, {
            carrier: values.carrier!,
            claimNumber: values.claimNumber!,
            policyNumber: values.policyNumber!,
            dateOfLoss: values.dateOfLoss ? values.dateOfLoss : null,
            lossCause: values.lossCause!,
            adjusterName: values.adjusterName!,
            adjusterEmail: values.adjusterEmail!,
            adjusterPhone: values.adjusterPhone!,
            deductible: values.deductible!,
            revision,
            changeId,
          })
        }
        reread={claimOf}
      />
    </div>
  );
}

// One whole record saved at once with the job revision it was read at and a change id made here.
// The boxes hold only what the person changed over the job as last read, so a box they never
// touched always saves what is stored now. A save with no answer is kept (src/lib/field/pending.ts,
// one per job for customer and claim together) and sent again with the same change id, so it is
// never taken for a conflict with itself; while it is unsettled the other record waits, because a
// save of it would move the job's revision on.
function RecordForm({
  job,
  title,
  kind,
  boxes,
  readOnly,
  send,
  reread,
}: {
  job: CustomerJob;
  title: string;
  kind: RecordKind;
  boxes: BoxSpec[];
  readOnly: boolean;
  send: (values: Values, revision: number, changeId: string) => Promise<Answer<JobDetail>>;
  reread: (detail: JobDetail) => Values;
}) {
  const jobId = job.detail.job.id;
  const [edits, setEdits] = useState<Values>({});
  const unsettled = usePending(() => pending.record(jobId));
  const mine = unsettled?.kind === kind ? unsettled : null;
  const waiting = unsettled !== null && mine === null;
  // In flight is kept with the save itself, so a form opened again while it is on its way waits.
  const busy = mine?.sending ?? false;
  // A refused save of this record, kept until the person changes or saves the form: their changes
  // stay on top of the job as read now, with the server's reason.
  const refusal = usePending(() => pending.refusal(jobId, kind));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = { ...refusal?.edits, ...edits };
  const shown = mine?.values ?? { ...reread(job.detail), ...changed };

  // Takes a kept refusal's changes into the form's own.
  function takeRefusal() {
    if (!refusal) return;
    pending.dropRefusal(jobId, kind);
    setEdits(changed);
    setError(refusal.message);
  }

  async function save() {
    if (!job.session.online) return setError('Needs a connection');
    const held = pending.record(jobId);
    if (held && (held.kind !== kind || held.sending)) return;
    takeRefusal();
    setError(null);
    setNotice(null);
    const attempt = {
      ...(held ?? { kind, changeId: crypto.randomUUID(), revision: job.detail.job.revision, values: shown, edits: changed }),
      sending: true,
    };
    pending.setRecord(jobId, attempt);
    const sentAt = pending.mark(jobId);
    const answer = await send(attempt.values, attempt.revision, attempt.changeId);
    // No answer at all keeps the save to send again; an answer settles it, and a refusal keeps the
    // person's changes and the reason (src/lib/field/pending.ts) for whichever form shows them.
    const refused = !answer.ok && answer.status !== 0 && answer.status < 500;
    const settlement = answer.ok ? 'answered' : refused ? { refused: answer.message } : 'unanswered';
    if (!pending.settleRecord(jobId, attempt.changeId, settlement)) return;
    if (answer.ok) {
      setEdits((current) => Object.fromEntries(Object.entries(current).filter(([key, value]) => attempt.values[key] !== value)));
      job.setDetail(answer.value, sentAt);
      setNotice(`${title} saved.`);
      return;
    }
    // Not this person's to see any more: every copy of the job goes. Changed elsewhere: read the job
    // again; the person's edits stay on top of the new values.
    if (answer.denied) pending.denyDetail(jobId, answer.message);
    if (answer.stale) await job.reloadJob();
    if (!refused) setError(answer.message);
  }

  const id = (key: string) => `${title.toLowerCase()}-${key}`;
  return (
    <form
      aria-label={title}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Section title={title}>
        {boxes.map((box) => (
          <Box
            key={box.key}
            id={id(box.key)}
            label={box.label}
            type={box.type}
            autoComplete={box.autoComplete}
            value={shown[box.key] ?? ''}
            readOnly={readOnly || mine !== null}
            onChange={(value) => {
              takeRefusal();
              setEdits((current) => ({ ...current, [box.key]: value }));
              setNotice(null);
            }}
          />
        ))}
        {readOnly ? null : (
          <Button type="submit" disabled={busy || waiting || !job.session.online}>
            {busy ? 'Saving…' : mine ? 'Try again' : `Save ${title.toLowerCase()}`}
          </Button>
        )}
        {!readOnly && !job.session.online ? <p role="status">Needs a connection</p> : null}
        {waiting ? (
          <p className="text-sm">The {unsettled.kind} save has not been answered yet. Try it again first.</p>
        ) : null}
        {mine && !busy && !error ? <p role="status">This {title.toLowerCase()} was sent but no answer came back. Try again to finish it.</p> : null}
        <Outcome error={error ?? refusal?.message ?? null} notice={notice} />
      </Section>
    </form>
  );
}
