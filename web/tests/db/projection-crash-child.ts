// Run by access-projection.test.ts as a separate process, then killed with SIGKILL while its store
// call is in progress: a real crash between the SQL side and the Firestore side. The store writes
// what it was asked to do to a file, then never returns.
import { writeFileSync } from 'node:fs';
import { openDatabase } from '@/db/client';
import { projectActor } from '@/lib/projection/outbox';
import type { AccessStore } from '@/lib/projection/store';

const { CRASH_DATABASE_URL, CRASH_COMPANY, CRASH_ACTOR, CRASH_MARKER } = process.env;
if (!CRASH_DATABASE_URL || !CRASH_COMPANY || !CRASH_ACTOR || !CRASH_MARKER) process.exit(2);

const hang = () => new Promise<never>(() => {});
const store: AccessStore = {
  async grant(grant) {
    writeFileSync(CRASH_MARKER, JSON.stringify({ kind: 'grant', ...grant }));
    return hang();
  },
  async remove(companyId, uid, version) {
    writeFileSync(CRASH_MARKER, JSON.stringify({ kind: 'remove', companyId, uid, version }));
    return hang();
  },
};

const { db } = openDatabase({ APP_ENV: 'test', DATABASE_URL: CRASH_DATABASE_URL });
await projectActor(db, store, CRASH_COMPANY, CRASH_ACTOR);
