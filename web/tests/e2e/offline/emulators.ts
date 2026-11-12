// Where the offline tests find the emulators (web/firebase.json) and the one project they use.
// Both run under a demo- project only, so nothing here can reach a real project.
import { AUTH_EMULATOR_HOST, E2E_PROJECT } from '../sign-in/emulator';

export { AUTH_EMULATOR_HOST, E2E_PROJECT };
export const FIRESTORE_EMULATOR_HOST = '127.0.0.1:8399';
// The field database the emulator serves (the server's FIRESTORE_DATABASE_ID in the emulators).
export const FIELD_DATABASE = '(default)';
