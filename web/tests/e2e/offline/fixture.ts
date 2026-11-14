// The Playwright fixtures for the offline tests (S6-1): a lane of its own per test, and a
// `Phone` that drives the test page inside one browser page.
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { parseBrowserSignInConfig, type BrowserSignInConfig } from '../../../src/lib/config';
import { harnessFiles } from './bundle';
import { E2E_PROJECT, FIELD_DATABASE } from './emulators';
import type { Harness, Boot, CacheKind } from './harness/page';
import { NetworkLane } from './lane';
import type { Person, World } from './world';

// What the app would hand the browser for this lane: the product's own settings function, with the
// lane's addresses standing in for the emulators'.
export function browserConfig(lane: NetworkLane): BrowserSignInConfig {
  const config = parseBrowserSignInConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: E2E_PROJECT,
    FIRESTORE_DATABASE_ID: FIELD_DATABASE,
    ...lane.env,
  });
  if (!config) throw new Error('the browser settings did not parse');
  return config;
}

export class Phone {
  private constructor(
    readonly page: Page,
    readonly lane: NetworkLane,
  ) {}

  // A new window of the browser, at the test page, served through the lane.
  static async open(context: BrowserContext, lane: NetworkLane): Promise<Phone> {
    const page = await context.newPage();
    await page.goto(`${lane.appUrl}/__harness/`);
    return new Phone(page, lane);
  }

  // Reloads the window: the page's memory goes, the phone's storage stays.
  async reload(): Promise<void> {
    await this.page.reload();
  }

  call<K extends keyof Harness>(method: K, ...args: Parameters<Harness[K]>): Promise<Awaited<ReturnType<Harness[K]>>> {
    return this.page.evaluate(([name, rest]) => (window as unknown as { h: Record<string, (...a: unknown[]) => unknown> }).h[name as string]!(...(rest as unknown[])), [method, args] as const) as Promise<Awaited<ReturnType<Harness[K]>>>;
  }

  // Starts the company's Firestore client under `key` (default "main").
  start(world: Pick<World, 'tenantId'>, cache: CacheKind, key = 'main', extra: Pick<Boot, 'networkOff'> = {}) {
    const boot: Boot = { config: browserConfig(this.lane), tenantId: world.tenantId, cache, ...extra };
    return this.call('open', key, boot);
  }

  signIn(person: Person, key = 'main') {
    return this.call('signIn', key, person.email, person.password);
  }

  // Closes this window and opens another in the same browser: the phone's storage stays, the
  // page's memory does not. The nearest a test gets to closing the app and opening it again.
  async restart(context: BrowserContext): Promise<Phone> {
    await this.page.close();
    return Phone.open(context, this.lane);
  }
}

type Fixtures = { lane: NetworkLane };

// Each offline test waits on the network coming back, often more than once, with polls of up to 45s.
export const OFFLINE_TEST_TIMEOUT = 180_000;

export const test = base.extend<Fixtures>({
  lane: async ({ serviceWorkers }, provide, testInfo) => {
    // The suite blocks service workers by default (playwright.config.ts); an offline test run with
    // it blocked would lose its worker coverage without failing, so it fails here instead.
    if (serviceWorkers !== 'allow') throw new Error("offline tests need test.use({ serviceWorkers: 'allow' })");
    testInfo.setTimeout(Math.max(testInfo.timeout, OFFLINE_TEST_TIMEOUT));
    const lane = await NetworkLane.open({ statics: await harnessFiles() });
    try {
      await provide(lane);
    } finally {
      await lane.close();
    }
  },
});

export { expect };

// After a write made while the network is cut: waits long enough for the write to have gone out
// if it could, and checks that nothing has gone through the lane to the Firestore emulator since
// the cut. Without it a test cannot tell "the write is waiting for the network" from "the write is
// still on its way".
// How long a write may take to reach the server once it can go: the budget a test gives a send, and
// so how long a write must stay off the server before a test calls it withheld.
export const SEND_MS = 30_000;

// Checks `unsent` every second for as long as a send may take, and fails the first time it is false.
export async function expectWithheld(unsent: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + SEND_MS;
  for (;;) {
    expect(await unsent(), 'the write reached the server').toBe(true);
    if (Date.now() >= until) return;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

export async function expectNothingSent(lane: NetworkLane, ms = 1200): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
  const sent = lane.bytesSinceCut('firestore');
  if (sent === null) throw new Error('the Firestore side of the lane is not cut');
  if (sent !== 0) throw new Error(`${sent} bytes reached Firestore while the network was cut`);
}
