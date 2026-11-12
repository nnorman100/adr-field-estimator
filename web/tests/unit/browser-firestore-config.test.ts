import { describe, expect, it } from 'vitest';
import { ConfigError, parseBrowserSignInConfig, parseConfig } from '@/lib/config';

// The two settings the browser needs to run the Firestore SDK against the field database (S6-1):
// the database id, and on a developer machine the Firestore emulator's address. Both are public
// values, like the Auth settings beside them. The sign-in tests (sign-in.test.ts) pin the rest.

const local = {
  APP_ENV: 'local',
  GOOGLE_CLOUD_PROJECT: 'demo-dryscope',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399',
};
const key = 'AIzaSyA-test-key-0123456789abcdefghij';
const test = {
  APP_ENV: 'test',
  GOOGLE_CLOUD_PROJECT: 'dryscope',
  FIREBASE_WEB_API_KEY: key,
  FIREBASE_AUTH_DOMAIN: 'dryscope.firebaseapp.com',
};

describe('the browser settings for the field database', () => {
  it('names the field database and the Firestore emulator on a developer machine', () => {
    expect(
      parseBrowserSignInConfig({ ...local, FIRESTORE_DATABASE_ID: '(default)', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8399' }),
    ).toEqual({
      apiKey: 'demo-emulator-api-key',
      authDomain: 'demo-dryscope.firebaseapp.com',
      projectId: 'demo-dryscope',
      authEmulatorUrl: 'http://127.0.0.1:9399',
      firestoreDatabaseId: '(default)',
      firestoreEmulatorUrl: 'http://127.0.0.1:8399',
    });
  });

  it('names the field database and no emulator on a deployed environment', () => {
    const config = parseBrowserSignInConfig({ ...test, FIRESTORE_DATABASE_ID: 'dryscope-field-test' });
    expect(config).toMatchObject({ projectId: 'dryscope', authEmulatorUrl: null, firestoreDatabaseId: 'dryscope-field-test' });
    expect(config).not.toHaveProperty('firestoreEmulatorUrl');
  });

  it('leaves both out when the server has neither, so sign-in alone still works', () => {
    for (const env of [local, test]) {
      const config = parseBrowserSignInConfig(env);
      expect(config).not.toBeNull();
      expect(config).not.toHaveProperty('firestoreDatabaseId');
      expect(config).not.toHaveProperty('firestoreEmulatorUrl');
    }
  });

  it('never hands the browser an emulator address outside a developer machine', () => {
    // The server's own settings refuse the emulator variable outside APP_ENV=local, and the
    // browser value follows the Auth emulator, so a deployed environment cannot carry one.
    const config = parseBrowserSignInConfig({ ...test, FIRESTORE_DATABASE_ID: '(default)' });
    expect(config).not.toHaveProperty('firestoreEmulatorUrl');
  });

  it('refuses a malformed Firestore emulator address without echoing it', () => {
    const bad = 'evil.example.com:8399';
    expect(() => parseConfig({ ...local, FIRESTORE_EMULATOR_HOST: bad })).toThrow(ConfigError);
    expect(() => parseConfig({ ...local, FIRESTORE_EMULATOR_HOST: bad })).not.toThrow(bad);
  });
});
