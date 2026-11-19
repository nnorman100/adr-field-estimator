'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { PhotoLog, Proposal } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/review-documents';
import { LinkPhoto } from '@/components/links/link-photo';
import { signedBy, signedHow, signedWhen } from '@/lib/agreements/screen';
import { platformPaths, type SupportJobAnswer } from '@/lib/operator/client';
import { JOB_STATUS_LABELS } from '@/lib/jobs/status-labels';
import { STATUS_LABELS, supportDate, supportReadMessage } from '@/lib/operator/screens';
import { ConnectionNotice } from '../../../../connection-notice';
import { useOperator } from '../../../../operator-session';
import { ErrorMessage, Section } from '../../../../ui';

const KIND_NAMES = { photo: 'Photo', original: 'Full-size original', signature: 'Signature' } as const;

// The read-only support view of one job (S5b-5; owner decision J8): its record, customer and claim,
// its signed agreement as stored, and its evidence (photos, originals and the signature of a committed
// agreement). Nothing here changes the job: no field, button or link writes anything, and archive
// and restore are the company owner's (owner decision B, 2026-11-19). Opening this page writes one
// audit row, so it is read once per opening; each image is fetched only when asked for, because each
// image read writes one too.
export function SupportJobScreen({ companyId, jobId }: { companyId: string; jobId: string }) {
  const { tenantId, call, image } = useOperator();
  const [loaded, setLoaded] = useState<SupportJobAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = jobPath(companyId, jobId);
  // One read per opening: React may run an effect twice in development, and each read is audited.
  const started = useRef(false);

  useEffect(() => {
    if (path === null || started.current) return;
    started.current = true;
    void (async () => {
      const result = await call<SupportJobAnswer>(path);
      if (!result.ok) {
        setError(
          result.code === 'not_found' ? 'That job was not found in this company.' : supportReadMessage(result.status, result.code, 'this job'),
        );
        return;
      }
      setLoaded(result.body);
    })();
  }, [call, path]);

  const back = (
    <Link href={`/operator/${tenantId}/companies/${companyId}/jobs`} className="w-fit font-medium underline underline-offset-4">
      Back to jobs
    </Link>
  );

  if (path === null) {
    return (
      <>
        <h1 className="text-2xl font-semibold leading-tight">Job not found</h1>
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
        <h1 className="text-2xl font-semibold leading-tight">Job</h1>
        <ConnectionNotice />
        {error ? <ErrorMessage text={error} /> : <p role="status">Loading the job…</p>}
        {back}
      </>
    );
  }

  const { company, job, customer, claim, agreement, evidence } = loaded;
  const load = (photoId: string, kind: keyof typeof KIND_NAMES) => image(platformPaths.supportPhoto(companyId, jobId, photoId, kind));
  return (
    <>
      <h1 className="text-2xl font-semibold leading-tight [overflow-wrap:anywhere]">{job.propertyAddress || 'No address yet'}</h1>
      <p className="text-sm">
        {company.name}, read-only support view. Company status: {STATUS_LABELS[company.status].toLowerCase()}. Opening
        this job and each image is recorded in the audit log. To archive or restore it, ask the company’s owner.
      </p>
      <ConnectionNotice />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">Status</dt>
        <dd>{JOB_STATUS_LABELS[job.status]}</dd>
        <dt className="font-medium">Revision</dt>
        <dd>{job.revision}</dd>
        <dt className="font-medium">Started</dt>
        <dd>{supportDate(job.createdAt)}</dd>
        <dt className="font-medium">Last changed</dt>
        <dd>{supportDate(job.updatedAt)}</dd>
      </dl>
      <Section title="Customer">
        <Details
          rows={[
            ['Name', customer.name],
            ['Phone', customer.phone],
            ['Email', customer.email],
          ]}
        />
      </Section>
      <Section title="Claim">
        <Details
          rows={[
            ['Carrier', claim.carrier],
            ['Claim number', claim.claimNumber],
            ['Policy number', claim.policyNumber],
            ['Date of loss', claim.dateOfLoss ?? ''],
            ['Cause of loss', claim.lossCause],
            ['Adjuster', claim.adjusterName],
            ['Adjuster email', claim.adjusterEmail],
            ['Adjuster phone', claim.adjusterPhone],
            ['Deductible', claim.deductible],
          ]}
        />
      </Section>
      <Section title="Signed agreement">
        {agreement ? (
          <div className="flex flex-col gap-3 [overflow-wrap:anywhere]">
            <p>{signedBy(agreement.record.signer)}</p>
            <p>{signedWhen(agreement.signedAt)}</p>
            <p>{signedHow(agreement.record)}</p>
            <p className="text-sm break-all">Proposal SHA-256 {agreement.record.proposal_sha256}</p>
            <div className="rounded-md border p-3">
              <Proposal proposal={agreement.record.proposal} />
            </div>
            <h3 className="font-semibold">Photo audit log</h3>
            <PhotoLog photos={agreement.record.documents.photo_log} />
          </div>
        ) : (
          <p>Not signed.</p>
        )}
      </Section>
      <Section title="Evidence">
        {evidence.length === 0 ? (
          <p>No photos or signature.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {evidence.map((item, index) => (
              <li key={`${item.kind}-${item.photoId}`} className="flex flex-col gap-1 rounded-md border p-3 [overflow-wrap:anywhere]">
                <p className="font-medium">
                  {KIND_NAMES[item.kind]} {index + 1}
                </p>
                <p className="text-sm">
                  {item.contentType} · {Math.max(1, Math.round(item.sizeBytes / 1024))} KB · received {supportDate(item.createdAt)}
                </p>
                <p className="text-sm break-all">SHA-256 {item.sha256}</p>
                <LinkPhoto label={`${KIND_NAMES[item.kind]} ${index + 1}`} load={() => load(item.photoId, item.kind)} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {back}
    </>
  );
}

// Label and value pairs; an empty value reads "Not entered".
function Details({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-medium">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value || 'Not entered'}</dd>
        </div>
      ))}
    </dl>
  );
}

function jobPath(companyId: string, jobId: string): string | null {
  try {
    return platformPaths.supportJob(companyId, jobId);
  } catch {
    return null;
  }
}
