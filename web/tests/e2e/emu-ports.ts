// The ports the browser tests' emulators and Next.js servers listen on. By default the fixed
// ports in firebase.json, tests/e2e/jobs/storage/firebase.json, and the E2E server helpers;
// EMU_*_PORT / E2E_*_PORT pins one and EMU_PORTS=auto picks free ones (tests/emu/ports.ts), so
// two runs on one machine do not fight over them. The first process to import this (Playwright's
// main process, through playwright.config.ts) claims them; child servers and Playwright's workers
// inherit the result through the environment and claim nothing.
import { EMU_PORT_DEFAULT, EMU_PORT_ENV, claimPorts, type ClaimOptions } from '../emu/ports';

export const E2E_SERVER_PORT_DEFAULT = {
  app: 3100,
  jobs: 3101,
  appCheck: 3103,
  appCheckJobs: 3104,
} as const;

export const E2E_SERVER_PORT_ENV = {
  app: 'E2E_APP_PORT',
  jobs: 'E2E_JOBS_PORT',
  appCheck: 'E2E_APP_CHECK_PORT',
  appCheckJobs: 'E2E_APP_CHECK_JOBS_PORT',
} as const;

const E2E_PORT_DEFAULT = { ...EMU_PORT_DEFAULT, ...E2E_SERVER_PORT_DEFAULT };
const E2E_PORT_ENV = { ...EMU_PORT_ENV, ...E2E_SERVER_PORT_ENV };
const E2E_PORT_KEYS = [
  'auth',
  'firestore',
  'firestoreWebsocket',
  'hub',
  'logging',
  'storage',
  'storageHub',
  'storageLogging',
  'app',
  'jobs',
  'appCheck',
  'appCheckJobs',
] as const;

export function claimE2ePorts(options: ClaimOptions = {}) {
  return claimPorts(E2E_PORT_KEYS, E2E_PORT_DEFAULT, E2E_PORT_ENV, options);
}

export const E2E_EMU = claimE2ePorts();
