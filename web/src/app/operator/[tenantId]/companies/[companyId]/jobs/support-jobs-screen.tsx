'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { platformPaths, type SupportJobsAnswer } from '@/lib/operator/client';
import { isSignInAgainCode, JOB_STATUS_LABELS, operatorErrorMessage, STATUS_LABELS, supportDate } from '@/lib/operator/screens';
import { useOperator } from '../../../operator-session';
import { ErrorMessage } from '../../../ui';

type Loaded = { company: SupportJobsAnswer['company']; jobs: SupportJobsAnswer['jobs']; nextCursor: string | null };

// The read-only support view of a company's jobs (S5b-5; owner decision J8). It lists every job of
// the company, archived ones too, newest first, and opens one. Nothing here changes a job: there is
// no edit, archive or restore control (owner decision B, 2026-11-19: the company owner archives and
// restores). Each page of the list the server sends writes one audit row, so the first page is read
// once per opening and the next only when asked for.
export function SupportJobsScreen({ companyId }: { companyId: string }) {
  const { tenantId, call } = useOperator();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const first = firstPath(companyId);
  // One read per opening: React may run an effect twice in development, and each read is audited.
  const started = useRef(false);

  useEffect(() => {
    if (first === null || started.current) return;
    started.current = true;
    void (async () => {
      const result = await call<SupportJobsAnswer>(first);
      if (!result.ok) {
        setError(messageFor(result.code));
        return;
      }
      setLoaded({ company: result.body.company, jobs: result.body.jobs, nextCursor: result.body.nextCursor });
    })();
  }, [call, first]);

  async function showMore() {
    if (!loaded?.nextCursor || more.busy) return;
    setMore({ busy: true, error: null });
    const result = await call<SupportJobsAnswer>(platformPaths.supportJobs(companyId, loaded.nextCursor));
    if (!result.ok) {
      setMore({ busy: false, error: messageFor(result.code) });
      return;
    }
    setLoaded((current) => (current ? { ...current, jobs: [...current.jobs, ...result.body.jobs], nextCursor: result.body.nextCursor } : current));
    setMore({ busy: false, error: null });
  }

  const back = (
    <Link href={`/operator/${tenantId}/companies/${companyId}`} className="w-fit font-medium underline underline-offset-4">
      Back to company
    </Link>
  );

  if (first === null) {
    return (
      <>
        <h1 className="text-2xl font-semibold leading-tight">Company not found</h1>
        <p>
          <Link href={`/operator/${tenantId}`} className="font-medium underline underline-offset-4">
            Back to Companies
          </Link>
        </p>
      </>
    );
  }

  if (!loaded) {
    return (
      <>
        <h1 className="text-2xl font-semibold leading-tight">Jobs</h1>
        {error ? <ErrorMessage text={error} /> : <p role="status">Loading the jobs…</p>}
        {back}
      </>
    );
  }

  const { company, jobs, nextCursor } = loaded;
  return (
    <>
      <h1 className="text-2xl font-semibold leading-tight">{company.name}: jobs</h1>
      <p className="text-sm">
        Read-only support view. Company status: {STATUS_LABELS[company.status].toLowerCase()}. Opening this list, each
        job and each photo is recorded in the audit log. To archive or restore a job, ask the company’s owner.
      </p>
      {jobs.length === 0 ? (
        <p>No jobs yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-col gap-1 rounded-md border p-3">
              <Link href={`/operator/${tenantId}/companies/${companyId}/jobs/${job.id}`} className="w-fit font-medium underline underline-offset-4">
                {job.propertyAddress || 'No address yet'}
              </Link>
              {job.customerName ? <p className="text-sm">{job.customerName}</p> : null}
              <p className="text-sm">
                {JOB_STATUS_LABELS[job.status] ?? job.status} · started {supportDate(job.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <div className="flex flex-col gap-1">
          <Button type="button" variant="outline" className="w-fit" disabled={more.busy} onClick={() => void showMore()}>
            {more.busy ? 'Loading more jobs…' : 'Show more jobs'}
          </Button>
          <ErrorMessage text={more.error} />
        </div>
      ) : null}
      {back}
    </>
  );
}

function messageFor(code: string): string {
  return isSignInAgainCode(code) ? 'Sign in again to view these jobs.' : operatorErrorMessage(code);
}

function firstPath(companyId: string): string | null {
  try {
    return platformPaths.supportJobs(companyId);
  } catch {
    return null;
  }
}
