// The ports the browser tests' emulators listen on. By default the fixed ports in firebase.json and
// tests/e2e/jobs/storage/firebase.json; EMU_*_PORT pins one and EMU_PORTS=auto picks free ones
// (tests/emu/ports.ts), so two runs on one machine do not fight over them. The first process to
// import this (Playwright's main process, through playwright.config.ts) claims them; Playwright's
// workers inherit the result through the environment and claim nothing.
import { claimEmuPorts } from '../emu/ports';

export const E2E_EMU = claimEmuPorts([
  'auth',
  'firestore',
  'firestoreWebsocket',
  'hub',
  'logging',
  'storage',
  'storageHub',
  'storageLogging',
]);
