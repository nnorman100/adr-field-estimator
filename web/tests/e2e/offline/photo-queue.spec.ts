import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type {} from './harness/photos';

const OWNER = { tenantId: 'company-a', uid: 'tech' };
const OTHER = { tenantId: 'company-b', uid: 'tech' };

type Upload = {
  photoId: string;
  kind: string;
  sha256: string;
  headers: IncomingMessage['headers'];
  response: ServerResponse;
};

function receipt(upload: Upload, sha256 = upload.sha256) {
  upload.response.writeHead(201, { 'Content-Type': 'application/json' });
  upload.response.end(JSON.stringify({ photoId: upload.photoId, sha256 }));
}

type PhotoServer = {
  origin: string;
  // What the server has committed, whether or not its answer arrived: the bytes seen for each stored
  // object, the photos with a registry row, and the photos with a reference document.
  objects: Map<string, Set<string>>;
  registry: Set<string>;
  references: Set<string>;
  // Records the object and registry row the server stored for an upload, as if its answer were lost.
  commit(upload: Upload): void;
  upload(upload: Upload): void;
  reference(response: ServerResponse): void;
};

let script: string;
const test = base.extend<{ photoServer: PhotoServer }>({
  photoServer: async ({}, provide) => {
    const handlers: PhotoServer = {
      origin: '',
      objects: new Map(),
      registry: new Set(),
      references: new Set(),
      commit(upload) {
        const object = `${upload.photoId}/${upload.kind}`;
        handlers.objects.set(object, (handlers.objects.get(object) ?? new Set()).add(upload.sha256));
        handlers.registry.add(upload.photoId);
      },
      upload: receipt,
      reference: (response) => response.writeHead(204).end(),
    };
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      if (path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><meta charset="utf-8"><script src="/queue.js"></script>');
      } else if (path === '/queue.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
      } else if (path.startsWith('/upload/')) {
        const [, , photoId, kind] = path.split('/');
        const hash = createHash('sha256');
        request.on('data', (chunk: Buffer) => hash.update(chunk));
        request.on('end', () => {
          const upload = { photoId: photoId!, kind: kind!, sha256: hash.digest('hex'), headers: request.headers, response };
          response.once('finish', () => {
            if (response.statusCode < 300) handlers.commit(upload);
          });
          handlers.upload(upload);
        });
      } else if (path.startsWith('/reference/')) {
        response.once('finish', () => {
          if (response.statusCode < 300) handlers.references.add(path.split('/')[2]!);
        });
        handlers.reference(response);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local receipt server port');
    handlers.origin = `http://127.0.0.1:${address.port}`;
    try {
      await provide(handlers);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
});

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./harness/photos.ts', import.meta.url))],
    tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    bundle: true,
    format: 'iife',
    write: false,
  });
  script = bundle.outputFiles[0]!.text;
});

async function open(context: BrowserContext, server: PhotoServer) {
  const page = await context.newPage();
  await page.goto(server.origin);
  return page;
}

const entries = (page: Page) => page.evaluate((owner) => window.photoHarness.entries(owner), OWNER);
const capture = (page: Page, jobId = 'job') =>
  page.evaluate(([owner, job]) => window.photoHarness.capture(owner, [80, 60], job), [OWNER, jobId] as const);
const payloads = (page: Page) => page.evaluate(() => window.photoHarness.bytes());
const start = (page: Page, owner = OWNER, ready = true) =>
  page.evaluate(([person, connected]) => window.photoHarness.open(person, connected), [owner, ready] as const);

test('saves a 12 MP capture before showing it, then resumes the same copy and waits for a tap to send the original', async ({ context, photoServer }) => {
  let page = await open(context, photoServer);
  const saved = await page.evaluate((owner) => window.photoHarness.capture(owner, [4000, 3000]), OWNER);
  expect(saved).toMatchObject({ stage: 'queued', kind: 'photo', field: { roomId: 'room', shotTag: 'overview' } });
  expect(await payloads(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', width: 2560, height: 1920 }),
    expect.objectContaining({ kind: 'original', width: 4000, height: 3000 }),
  ]));
  await page.close();

  const uploads: Upload[] = [];
  photoServer.upload = (upload) => {
    uploads.push(upload);
    receipt(upload);
  };
  page = await open(context, photoServer);
  expect(await entries(page)).toEqual(expect.arrayContaining([saved]));
  await start(page, OWNER, false);
  expect(uploads).toEqual([]);
  await page.evaluate(() => window.photoHarness.ready());
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
  expect(uploads.map(({ kind }) => kind)).toEqual(['photo']);
  expect(await payloads(page)).toEqual([expect.objectContaining({ kind: 'original' })]);

  await page.evaluate(() => window.photoHarness.originals());
  await expect.poll(() => payloads(page)).toEqual([]);
  expect(uploads.map(({ kind }) => kind)).toEqual(['photo', 'original']);
  expect(uploads.map(({ photoId }) => photoId)).toEqual(Array(2).fill((saved as { photoId: string }).photoId));
  expect(uploads[1]!.headers['x-photo-sha256']).toBe(uploads[0]!.sha256);
});

test('a closed page resumes an unacknowledged reference with its bytes and without another upload', async ({ context, photoServer }) => {
  let page = await open(context, photoServer);
  await capture(page);
  let uploads = 0;
  let references = 0;
  photoServer.upload = (upload) => {
    uploads += 1;
    receipt(upload);
  };
  photoServer.reference = (response) => {
    references += 1;
    if (references > 1) response.writeHead(409).end('The draft was finished.');
  };
  await start(page);
  await expect.poll(() => references).toBe(1);
  expect(await entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'referenced' })]));
  await page.close();

  page = await open(context, photoServer);
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', stage: 'blocked', reason: 'The draft was finished.' }),
  ]));
  expect(uploads).toBe(1);
  expect(await payloads(page)).toHaveLength(2);
});

test('two windows share a drainer with two uploads in flight and company B cannot send company A’s photos', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  for (let i = 0; i < 3; i += 1) await capture(page);
  const second = await open(context, photoServer);
  const third = await open(context, photoServer);
  const uploads: Upload[] = [];
  photoServer.upload = (upload) => { uploads.push(upload); };
  await start(third, OTHER);
  await expect.poll(() => third.evaluate(() => navigator.locks.query().then(({ held }) => held?.length))).toBe(0);
  expect(uploads).toEqual([]);

  await Promise.all([start(page), start(second)]);
  await expect.poll(() => uploads.length).toBe(2);
  expect((await entries(page)).filter(({ kind }) => kind === 'photo')).toHaveLength(3);
  uploads.slice().forEach((upload) => receipt(upload));
  await expect.poll(() => uploads.length).toBe(3);
  receipt(uploads[2]!);
  await expect.poll(async () => (await entries(page)).filter(({ stage }) => stage === 'done')).toHaveLength(3);
  expect(new Set(uploads.map(({ photoId }) => photoId)).size).toBe(3);
});

test('a full store rolls back both entries and payloads for the new capture and preserves earlier photos', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  const before = await entries(page);
  const bytesBefore = await payloads(page);
  await page.evaluate(() => window.photoHarness.failSecondPayload());
  expect(await capture(page)).toEqual({ error: 'QuotaExceededError' });
  expect(await entries(page)).toEqual(before);
  expect(await payloads(page)).toEqual(bytesBefore);
  expect(await page.evaluate(async () => {
    Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ quota: 100_000_000, usage: 99_000_000 }) });
    return window.photoHarness.storage();
  })).toBe(true);
});

test('an upload with a different receipt hash stops and keeps its bytes', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  photoServer.upload = (upload) => receipt(upload, '0'.repeat(64));
  let references = 0;
  photoServer.reference = (response) => {
    references += 1;
    response.writeHead(204).end();
  };
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', stage: 'blocked', reason: expect.stringMatching(/receipt/i) }),
  ]));
  expect(references).toBe(0);
  expect(await payloads(page)).toHaveLength(2);
});

test('a rate limit waits for Retry-After before retrying, and a conflict then stops with the reason', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  const attempts: string[] = [];
  photoServer.upload = ({ sha256, response }) => {
    attempts.push(sha256);
    if (attempts.length === 1) response.writeHead(429, { 'Retry-After': '4' }).end();
    else response.writeHead(409).end('A different photo already uses this id.');
  };
  await start(page);
  await expect.poll(async () => (await entries(page)).find(({ kind }) => kind === 'photo')).toMatchObject({
    stage: 'queued',
    attempts: 1,
  });
  await page.clock.runFor(2000);
  expect(attempts).toHaveLength(1);
  await page.clock.runFor(5000);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', stage: 'blocked', reason: 'A different photo already uses this id.' }),
  ]));
  await page.clock.runFor(60_000);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  expect(await payloads(page)).toHaveLength(2);
});

test('a lost upload receipt is retried with the same id and bytes even on an older Safari', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await page.evaluate(() => Object.defineProperty(AbortSignal, 'any', { value: undefined }));
  await capture(page);
  const attempts: { photoId: string; sha256: string }[] = [];
  photoServer.upload = (upload) => {
    const { photoId, sha256, response } = upload;
    attempts.push({ photoId, sha256 });
    if (attempts.length === 1) {
      photoServer.commit(upload);
      response.destroy();
    } else receipt(upload);
  };
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(await payloads(page)).toEqual([expect.objectContaining({ kind: 'original' })]);
  const { photoId } = attempts[0]!;
  expect([...photoServer.objects.keys()]).toEqual([`${photoId}/photo`]);
  expect([...photoServer.objects.get(`${photoId}/photo`)!]).toEqual([attempts[0]!.sha256]);
  expect([...photoServer.registry]).toEqual([photoId]);
  expect([...photoServer.references]).toEqual([photoId]);
});

test('an answer that arrives while the app is hidden is still recorded, and Retry-After still holds', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  const attempts: Upload[] = [];
  photoServer.upload = (upload) => { attempts.push(upload); };
  await start(page);
  await expect.poll(() => attempts.length).toBe(1);
  await page.evaluate(() => window.photoHarness.show(false));
  attempts[0]!.response.writeHead(429, { 'Retry-After': '60' }).end();
  await expect.poll(async () => (await entries(page)).find(({ kind }) => kind === 'photo')).toMatchObject({ stage: 'queued', attempts: 1 });
  await page.evaluate(() => window.photoHarness.show(true));
  await page.clock.runFor(10_000);
  expect(attempts).toHaveLength(1);
});

test('a reference acknowledged while the app is hidden is recorded', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  let reference: ServerResponse | undefined;
  photoServer.reference = (response) => { reference = response; };
  await start(page);
  await expect.poll(() => reference).toBeDefined();
  await page.evaluate(() => window.photoHarness.show(false));
  reference!.writeHead(204).end();
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
});

test('a GPS-tagged capture whose canvas encoding fails is kept verbatim as a stopped original, and nothing is ever sent for it', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  const uploads: Upload[] = [];
  photoServer.upload = (upload) => {
    uploads.push(upload);
    receipt(upload);
  };
  const { entry, fixtureSha256 } = await page.evaluate((owner) => window.photoHarness.captureGps(owner), OWNER);
  expect(entry).toMatchObject({ kind: 'original', stage: 'blocked', requested: false, reason: expect.stringMatching(/shareable copy/) });
  await start(page);
  await page.evaluate(() => window.photoHarness.originals('job'));
  await page.clock.install();
  await page.clock.runFor(10_000);
  expect(uploads).toEqual([]);
  expect(photoServer.objects.size).toBe(0);
  expect(await entries(page)).toEqual([expect.objectContaining({ kind: 'original', stage: 'blocked' })]);
  expect(await payloads(page)).toEqual([expect.objectContaining({ kind: 'original', width: 80, height: 60, sha256: fixtureSha256 })]);
});

test('a sign-in refusal keeps the work for the next sign-in, and a disabled member stops the photo with the reason', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  let attempts = 0;
  photoServer.upload = ({ response }) => {
    attempts += 1;
    response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'sign_in_revoked' }));
  };
  await start(page);
  await expect.poll(() => page.evaluate(() => window.photoHarness.signInRequests())).toBe(1);
  await page.clock.runFor(120_000);
  expect(attempts).toBe(1);
  expect(await entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'queued', attempts: 0 })]));
  expect(await payloads(page)).toHaveLength(2);

  photoServer.upload = ({ response }) => {
    attempts += 1;
    response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'member_disabled' }));
  };
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', stage: 'blocked', reason: JSON.stringify({ error: 'member_disabled' }) }),
  ]));
  expect(attempts).toBe(2);
  expect(await payloads(page)).toHaveLength(2);
});

test('a second-step refusal keeps the work for the next sign-in instead of stopping it', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  let attempts = 0;
  photoServer.upload = ({ response }) => {
    attempts += 1;
    response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'second_step_required' }));
  };
  await start(page);
  await expect.poll(() => page.evaluate(() => window.photoHarness.signInRequests())).toBe(1);
  await page.clock.runFor(120_000);
  expect(attempts).toBe(1);
  expect(await entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'queued', attempts: 0 })]));
  expect(await payloads(page)).toHaveLength(2);
});

test('the foreground check reads only work allowed now: untapped originals stay out until a tap brings them in', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page, 'job-a');
  await capture(page, 'job-b');
  await start(page);
  await expect.poll(() => entries(page).then((all) => all.filter(({ kind, stage }) => kind === 'photo' && stage === 'done'))).toHaveLength(2);
  const pending = () => page.evaluate((owner) => window.photoHarness.pending(owner), OWNER);
  expect(await pending()).toEqual([]);

  const held: Upload[] = [];
  photoServer.upload = (upload) => { held.push(upload); };
  await page.evaluate(() => { void window.photoHarness.originals('job-a'); });
  await expect.poll(() => held.length).toBe(1);
  expect((await pending()).map(({ jobId, kind, stage }) => [jobId, kind, stage]).sort()).toEqual([
    ['job-a', 'original', 'queued'],
    ['job-a', 'photo', 'done'],
  ]);
  receipt(held[0]!);
  await expect.poll(pending).toEqual([]);
  expect(await entries(page)).toHaveLength(4);
  expect(await page.evaluate((owner) => window.photoHarness.pending(owner), OTHER)).toEqual([]);
});

test('an original goes once its photo is registered and the tap is made, even when the photo’s reference was refused', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  const uploads: Upload[] = [];
  photoServer.upload = (upload) => {
    uploads.push(upload);
    receipt(upload);
  };
  photoServer.reference = (response) => response.writeHead(409).end('The draft was finished.');
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'photo', stage: 'blocked', reason: 'The draft was finished.', receipt: true }),
  ]));
  expect(uploads.map(({ kind }) => kind)).toEqual(['photo']);
  await page.evaluate(() => window.photoHarness.originals('job'));
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'original', stage: 'done' })]));
  expect(uploads.map(({ kind }) => kind)).toEqual(['photo', 'original']);
});

test('an original with no registered photo stays on the phone after the tap', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  const uploads: Upload[] = [];
  photoServer.upload = (upload) => {
    uploads.push(upload);
    upload.response.writeHead(409).end('A different photo already uses this id.');
  };
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'blocked' })]));
  await page.evaluate(() => window.photoHarness.originals('job'));
  await page.clock.install();
  await page.clock.runFor(10_000);
  expect(uploads.map(({ kind }) => kind)).toEqual(['photo']);
  expect(await entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'original', stage: 'queued', requested: true })]));
  expect(await payloads(page)).toHaveLength(2);
});

test('an App Check refusal is retried with a fresh token and does not pause the sign-in', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  let attempts = 0;
  photoServer.upload = (upload) => {
    attempts += 1;
    if (attempts === 1) upload.response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'app_check_required' }));
    else receipt(upload);
  };
  await start(page);
  await expect.poll(async () => (await entries(page)).find(({ kind }) => kind === 'photo')).toMatchObject({ stage: 'queued', attempts: 1 });
  await page.clock.runFor(10_000);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
  expect(await page.evaluate(() => window.photoHarness.signInRequests())).toBe(0);
});

test('an App Check refusal of the reference is retried and does not pause the sign-in', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  let references = 0;
  photoServer.reference = (response) => {
    references += 1;
    if (references === 1) response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'app_check_required' }));
    else response.writeHead(204).end();
  };
  await start(page);
  await expect.poll(() => references).toBe(1);
  await expect.poll(async () => (await entries(page)).find(({ kind }) => kind === 'photo')).toMatchObject({ stage: 'referenced', attempts: 1 });
  await page.clock.runFor(10_000);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
  expect(await page.evaluate(() => window.photoHarness.signInRequests())).toBe(0);
});

test('a sign-in refusal of the reference keeps the saved reference and the bytes for the next sign-in', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await page.clock.install();
  let references = 0;
  photoServer.reference = (response) => {
    references += 1;
    response.writeHead(401).end();
  };
  await start(page);
  await expect.poll(() => page.evaluate(() => window.photoHarness.signInRequests())).toBe(1);
  await page.clock.runFor(120_000);
  expect(references).toBe(1);
  expect(photoServer.references.size).toBe(0);
  expect(await entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'referenced', attempts: 0 })]));
  expect(await payloads(page)).toHaveLength(2);
});

test('the upload and the reference each get their own deadline, and the upload one grows with the bytes', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page);
  await start(page);
  await expect.poll(() => entries(page)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'photo', stage: 'done' })]));
  const deadlines = (await page.evaluate(() => window.photoHarness.timeouts())).filter((ms) => ms !== 5_000);
  expect(deadlines).toHaveLength(2);
  expect(deadlines[0]).toBeGreaterThan(30_000);
  expect(deadlines[0]).toBeLessThanOrEqual(300_000);
  expect(deadlines[1]).toBe(30_000);
});

test('Send originals on one job leaves another job’s originals waiting', async ({ context, photoServer }) => {
  const page = await open(context, photoServer);
  await capture(page, 'job-a');
  await capture(page, 'job-b');
  const uploads: Upload[] = [];
  photoServer.upload = (upload) => {
    uploads.push(upload);
    receipt(upload);
  };
  await start(page);
  await expect.poll(() => entries(page).then((all) => all.filter(({ kind, stage }) => kind === 'photo' && stage === 'done'))).toHaveLength(2);
  await page.evaluate(() => window.photoHarness.originals('job-a'));
  await expect.poll(() => entries(page).then((all) => all.filter(({ kind, stage }) => kind === 'original' && stage === 'done'))).toHaveLength(1);
  await page.clock.install();
  await page.clock.runFor(10_000);
  expect(await entries(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ jobId: 'job-a', kind: 'original', stage: 'done' }),
    expect.objectContaining({ jobId: 'job-b', kind: 'original', stage: 'queued', requested: false }),
  ]));
  expect(uploads.filter(({ kind }) => kind === 'original')).toHaveLength(1);
});
