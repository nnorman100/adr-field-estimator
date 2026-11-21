import { createHash, randomUUID } from 'node:crypto';
import { expect, expectWithheld, SEND_MS, test } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import { fenceDraft, readDoc, seedCompany } from './world';

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
      await phone.call('photoDrain', firstSignIn, world.companyId);
      await expectWithheld(() => Promise.resolve(uploads === 0));
      await phone.call('signOutKeep', firstSignIn);
      phone = await phone.restart(context);
      expect(await phone.call('queuedPhotos', firstSignIn)).toEqual(expect.arrayContaining([capture]));

      serveMe(lane, { expiresAt: inDays(7) });
      const signedIn = await phone.signIn(world, world.owner);
      expect(await phone.call('start', signedIn, 'persistent')).toBe('persistent');
      await phone.call('sync', signedIn);
      await expect.poll(() => phone.call('gate', signedIn)).toBe('open');
      await phone.call('photoDrain', signedIn, world.companyId);
      await expect.poll(() => phone.call('queuedPhotos', signedIn), { timeout: SEND_MS }).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'photo', photoId: capture.photoId, stage: fenced ? 'blocked' : 'done', receipt: true }),
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
