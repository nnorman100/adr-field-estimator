import { createHash, randomUUID } from 'node:crypto';
import { expect, expectWithheld, SEND_MS, test } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import { adminDb, fenceDraft, readDoc, seedCompany } from './world';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

for (const fenced of [false, true]) {
  test(`the field photo queue waits for access and keeps work through sign-in (${fenced ? 'fenced' : 'acknowledged'} reference)`, async ({ browser, lane }) => {
    const context = await browser.newContext();
    try {
      const world = await seedCompany();
      const jobId = randomUUID();
      let phone = await FieldPhone.open(context, lane);
      const firstSignIn = await phone.signIn(world, world.owner);
      serveMe(lane, { expiresAt: null });
      expect(await phone.call('start', firstSignIn, 'persistent')).toBe('persistent');
      await phone.call('sync', firstSignIn);
      await expect.poll(() => phone.call('gate', firstSignIn)).toBe('renewing');
      const capture = await phone.call('captureQueuedPhoto', firstSignIn, jobId, world.draftId);
      let uploads = 0;
      lane.serve(`/api/jobs/${jobId}/photos/${capture.photoId}`, async (_headers, url, request) => {
        expect(new URL(url, lane.appUrl).searchParams.get('kind')).toBe('photo');
        expect(request.method).toBe('PUT');
        uploads += 1;
        if (fenced) await fenceDraft(world);
        return {
          type: 'application/json',
          status: 201,
          body: JSON.stringify({ photoId: capture.photoId, sha256: createHash('sha256').update(request.body).digest('hex') }),
        };
      });
      await phone.call('photoDrain', firstSignIn);
      await expectWithheld(() => Promise.resolve(uploads === 0));
      await phone.call('signOutKeep', firstSignIn);
      phone = await phone.restart(context);
      expect(await phone.call('queuedPhotos', firstSignIn)).toEqual(expect.arrayContaining([capture]));

      serveMe(lane, { expiresAt: inDays(7) }, { companyId: world.companyId });
      const signedIn = await phone.signIn(world, world.owner);
      expect(await phone.call('start', signedIn, 'persistent')).toBe('persistent');
      await phone.call('sync', signedIn);
      await expect.poll(() => phone.call('gate', signedIn)).toBe('open');
      await phone.call('photoDrain', signedIn);
      await expectWithheld(() => Promise.resolve(uploads === 0));
      serveMe(lane, { expiresAt: inDays(7) }, { companyId: world.companyId, capabilities: ['scope', 'photos'] });
      await phone.call('poke', signedIn);
      await expect.poll(() => phone.call('queuedPhotos', signedIn), { timeout: SEND_MS }).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'photo', photoId: capture.photoId, stage: fenced ? 'blocked' : 'done', receipt: true, ...(fenced ? { reason: 'This job was finished.' } : {}) }),
        expect.objectContaining({ kind: 'original', requested: false }),
      ]));
      expect(uploads).toBe(1);
      const reference = await readDoc(`${world.draftPath}/photos/${capture.photoId}`);
      expect(reference).toEqual(fenced ? null : { field: capture.field });
      const payloads = await phone.page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ds-queue');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise<number>((resolve, reject) => {
            const request = db.transaction('bytes').objectStore('bytes').count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      });
      expect(payloads).toBe(fenced ? 2 : 1);
    } finally {
      await context.close();
    }
  });
}

for (const [reason, message, jobStatus] of [
  ['archived', 'This job was archived.', 410],
  ['owner-changed', 'Another person owns this job’s field work now.', 200],
  ['no-access', 'This job is not in your list.', 404],
] as const) {
  test(`a photo refused as ${reason} appears in recovery with no journal entry`, async ({ context, lane }) => {
    const world = await seedCompany({ people: ['owner', 'other'] });
    const jobId = randomUUID();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    serveMe(lane, { expiresAt: inDays(7) }, { companyId: world.companyId, capabilities: ['scope', 'photos'] });
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('open');

    const json = (status: number, body: unknown) => ({ status, type: 'application/json', body: JSON.stringify(body) });
    lane.serve(`/api/jobs/${jobId}`, json(jobStatus, jobStatus === 200 ? {
      job: {
        id: jobId, status: 'draft', currentDraftId: world.draftId, fieldOwnerActorId: 'other',
        propertyAddress: '', revision: 1, createdAt: '', updatedAt: '',
      },
      customer: { name: '', phone: '', email: '' },
      claim: {
        carrier: '', claimNumber: '', policyNumber: '', dateOfLoss: null, lossCause: '',
        adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '',
      },
    } : { error: jobStatus === 410 ? 'job_archived' : 'not_found' }));
    const capture = await phone.call('captureQueuedPhoto', person, jobId, world.draftId);
    lane.serve(`/api/jobs/${jobId}/photos/${capture.photoId}`, async (_headers, _url, request) => {
      expect(request.method).toBe('PUT');
      if (jobStatus === 410) return json(410, { error: 'job_archived' });
      await adminDb().doc(world.draftPath).update({ fieldOwnerUid: world.people.other!.uid });
      return json(201, { photoId: capture.photoId, sha256: createHash('sha256').update(request.body).digest('hex') });
    });
    await phone.call('photoDrain', person);
    await expect.poll(() => phone.call('photoRecovery', person), { timeout: SEND_MS }).toMatchObject({
      kind: 'cant-save',
      problems: [{
        reason, jobId, saveAsNew: jobStatus !== 404, entries: [],
        photos: [{ photoId: capture.photoId, stage: 'blocked', reason: message }],
      }],
    });
    expect(await phone.call('journal', person)).toEqual([]);
    expect(await readDoc(`${world.draftPath}/photos/${capture.photoId}`)).toBeNull();
  });
}
