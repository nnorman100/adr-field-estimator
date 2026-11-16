'use client';

import { useEffect, useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import { UnsentMarkNotSaved } from '@/lib/field-db';
import { queueFieldEdit } from '@/lib/field/local-edit';
import { fieldRefusal } from '@/lib/field/store';
import type { JobContext } from './job-screens';

// A form waits for local persistence, so the technician can keep working with no signal.
// Only its own SDK promise may later say Saved. A newer save owns the notice; an older promise
// must not replace it. No retry or recovery journal is introduced here (S6-4).
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

  async function save(write: (db: Firestore) => Promise<void>, saved: string, locallySaved: () => void = () => undefined) {
    if (!job.editable || job.stale) return;
    const mine = ++latest.current;
    const current = () => live.current && mine === latest.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    const refused = (error: unknown) => {
      if (current()) {
        setError(error instanceof UnsentMarkNotSaved
          ? `Can't save. ${error.message}`
          : "Can't save. The server has not accepted this change. Check access and try again.");
        setNotice(null);
      }
      job.checkAccess(fieldRefusal(error));
    };
    try {
      const { acknowledged } = await queueFieldEdit(job.session.client, job.draftRef, write);
      // The SDK's local transaction is finished; update the draft before clearing the form's edits.
      await job.reloadDraft('cache');
      if (current()) {
        locallySaved();
        setNotice(job.session.client.cache === 'persistent'
          ? 'Saved on this phone. Waiting to send.'
          : 'Waiting to send. This change will be lost if you leave this window.');
      }
      void acknowledged.then(
        () => {
          if (current()) setNotice(saved);
        },
        refused,
      );
    } catch (error) {
      refused(error);
    } finally {
      if (current()) setBusy(false);
    }
  }
  return { busy, error, notice, setError, setNotice, save };
}
