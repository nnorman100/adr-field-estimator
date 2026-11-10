// Emulator tests only ever run under a `demo-` project id. The Firebase CLI keeps a demo-
// project fully offline (no real project, users or data can be reached), so a wrong id is
// refused before anything starts, and again inside the test run itself.

export const DEFAULT_EMU_PROJECT = 'demo-dryscope';

// A Google Cloud project id is 6-30 characters of lowercase letters, digits and hyphens and
// does not end with a hyphen. Here it must also start with `demo-`.
const DEMO_PROJECT = /^demo-[a-z0-9-]{0,24}[a-z0-9]$/;

export function requireDemoProject(projectId: string | undefined): string {
  if (!projectId || !DEMO_PROJECT.test(projectId)) {
    throw new Error(
      `Emulator tests refuse project id ${JSON.stringify(projectId ?? '')}: it must start with "demo-"`,
    );
  }
  return projectId;
}

function requireLoopback(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set; run the emulator tests with npm run test:emu`);
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${value}`).hostname;
  } catch {
    throw new Error(`${name} must be host:port`);
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`${name} must point at a loopback emulator`);
  }
  return value;
}

export type EmulatorEnv = { projectId: string; authHost: string; firestoreHost: string };

// `firebase emulators:exec` sets these for the command it runs.
export function requireEmulatorEnv(env: Record<string, string | undefined>): EmulatorEnv {
  return {
    projectId: requireDemoProject(env.GCLOUD_PROJECT),
    authHost: requireLoopback('FIREBASE_AUTH_EMULATOR_HOST', env.FIREBASE_AUTH_EMULATOR_HOST),
    firestoreHost: requireLoopback('FIRESTORE_EMULATOR_HOST', env.FIRESTORE_EMULATOR_HOST),
  };
}
