'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { saveClaim, saveCustomer, type Answer, type JobDetail } from '@/lib/field/api';
import type { JobContext } from './job-screens';
import { Box, Outcome, Section } from './ui';

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
export function CustomerView({ job }: { job: JobContext }) {
  const canSave = job.session.capabilities.some((key) => key === 'scope' || key === 'coordination');
  return (
    <div className="flex flex-col gap-4">
      <h3 className="sr-only">Customer and claim</h3>
      <RecordForm
        job={job}
        title="Customer"
        boxes={CUSTOMER}
        initial={customerOf(job.detail)}
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
        boxes={CLAIM}
        initial={claimOf(job.detail)}
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
// A save with no answer is sent again with the same change id, so it is never taken for a
// conflict with itself.
function RecordForm({
  job,
  title,
  boxes,
  initial,
  readOnly,
  send,
  reread,
}: {
  job: JobContext;
  title: string;
  boxes: BoxSpec[];
  initial: Values;
  readOnly: boolean;
  send: (values: Values, revision: number, changeId: string) => Promise<Answer<JobDetail>>;
  reread: (detail: JobDetail) => Values;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [pending, setPending] = useState<{ changeId: string; revision: number; values: Values } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const attempt = pending ?? { changeId: crypto.randomUUID(), revision: job.detail.job.revision, values };
    setPending(attempt);
    const answer = await send(attempt.values, attempt.revision, attempt.changeId);
    setBusy(false);
    if (answer.ok) {
      setPending(null);
      job.setDetail(answer.value);
      setValues(reread(answer.value));
      setNotice(`${title} saved.`);
      return;
    }
    if (answer.status !== 0 && answer.status < 500) setPending(null);
    // Changed elsewhere: show the job as it is now, and let the person make their change again.
    if (answer.stale) {
      const fresh = await job.reloadJob();
      if (fresh) setValues(reread(fresh));
    }
    setError(answer.message);
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
            value={(pending?.values ?? values)[box.key] ?? ''}
            readOnly={readOnly || pending !== null}
            onChange={(value) => {
              setValues((current) => ({ ...current, [box.key]: value }));
              setNotice(null);
            }}
          />
        ))}
        {readOnly ? null : (
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : pending ? 'Try again' : `Save ${title.toLowerCase()}`}
          </Button>
        )}
        <Outcome error={error} notice={notice} />
      </Section>
    </form>
  );
}
