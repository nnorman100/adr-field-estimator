'use client';

import { useEffect, useRef, useState } from 'react';
import { UnsentMarkNotSaved } from '@/lib/field-db';
import { ReopenTheApp } from '@/lib/field/idb';
import { JournalNotSaved, type DocWrite, type Docs } from '@/lib/field/journal';
import { journaledEdit } from '@/lib/field/journal-sync';
import { draftDocs, fieldRefusal } from '@/lib/field/store';
import type { JobContext } from './job-screens';

// A form waits for local persistence, so the technician can keep working with no signal.
// Only its own SDK promise may later say Saved. A newer save owns the notice; an older promise
// must not replace it. Each edit goes into the phone's recovery journal first (S6-4).
export function useFieldEdit(job: JobContext) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // Answers whether the change was saved on the phone, also when the form is gone by then.
  async function save(writes: DocWrite[], saved: string, locallySaved: () => void = () => undefined, acknowledgedBy: () => void = () => undefined, held: Docs = draftDocs(job.draftRef, job.draft)): Promise<boolean> {
    if (!job.editable || job.stale) return false;
    let onPhone = false;
    const mine = ++latest.current;
    const current = () => live.current && mine === latest.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    const refused = (error: unknown) => {
      if (current()) {
        setError(error instanceof UnsentMarkNotSaved || error instanceof JournalNotSaved || error instanceof ReopenTheApp
          ? `Can't save. ${error.message}`
          : "Can't save. The server has not accepted this change. Check access and try again.");
        setNotice(null);
      }
      job.checkAccess(fieldRefusal(error));
    };
    try {
      const { acknowledged } = await journaledEdit(job.session.client, job.draftRef, writes, job.jobId, held);
      // The SDK's local transaction is finished; update the draft before clearing the form's edits.
      await job.reloadDraft('cache');
      onPhone = true;
      if (current()) {
        locallySaved();
        setNotice(job.session.client.cache === 'persistent'
          ? 'Saved on this phone. Waiting to send.'
          : 'Waiting to send. This change will be lost if you leave this window.');
      }
      void acknowledged.then(
        () => {
          acknowledgedBy();
          if (current()) setNotice(saved);
        },
        refused,
      );
    } catch (error) {
      refused(error);
    } finally {
      if (current()) setBusy(false);
    }
    return onPhone;
  }
  return { busy, error, notice, setError, setNotice, save };
}
