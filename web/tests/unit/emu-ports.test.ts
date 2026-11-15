import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tryAcquireLock } from '../emu/lock';
import {
  EMU_PORT_DEFAULT,
  EMU_PORT_ENV,
  claimEmuPorts,
  claimPorts,
  emuPort,
  isPortFree,
  writeEmulatorConfig,
  type EmuPort,
} from '../emu/ports';
import { E2E_SERVER_PORT_DEFAULT, E2E_SERVER_PORT_ENV, claimE2ePorts } from '../e2e/emu-ports';

const webDir = fileURLToPath(new URL('../..', import.meta.url));
const ALL = Object.keys(EMU_PORT_DEFAULT) as EmuPort[];

function holdPort(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('emulator port settings', () => {
  it('keep the ports firebase.json and the storage config already name as their defaults', () => {
    const main = JSON.parse(readFileSync(join(webDir, 'firebase.json'), 'utf8')).emulators;
    const storage = JSON.parse(readFileSync(join(webDir, 'tests/e2e/jobs/storage/firebase.json'), 'utf8')).emulators;
    expect(EMU_PORT_DEFAULT.auth).toBe(main.auth.port);
    expect(EMU_PORT_DEFAULT.firestore).toBe(main.firestore.port);
    expect(EMU_PORT_DEFAULT.storage).toBe(storage.storage.port);
    expect(EMU_PORT_DEFAULT.storageHub).toBe(storage.hub.port);
    expect(EMU_PORT_DEFAULT.storageLogging).toBe(storage.logging.port);
    // The Firebase CLI's own defaults for what firebase.json leaves out (seen in a run's output).
    expect([EMU_PORT_DEFAULT.hub, EMU_PORT_DEFAULT.logging, EMU_PORT_DEFAULT.firestoreWebsocket]).toEqual([4400, 4500, 9150]);
  });

  it('read an explicit port from the environment and fall back to the default', () => {
    expect(emuPort('auth', {})).toBe(9399);
    expect(emuPort('firestore', {})).toBe(8399);
    expect(emuPort('auth', { EMU_AUTH_PORT: '9500' })).toBe(9500);
    for (const bad of ['abc', '0', '80', '65536', '9500.5', ' ']) {
      expect(() => emuPort('auth', { EMU_AUTH_PORT: bad })).toThrow(/EMU_AUTH_PORT/);
    }
  });

  it('name one variable per port', () => {
    expect(new Set(Object.values(EMU_PORT_ENV)).size).toBe(ALL.length);
    expect(EMU_PORT_ENV.auth).toBe('EMU_AUTH_PORT');
    expect(EMU_PORT_ENV.firestore).toBe('EMU_FIRESTORE_PORT');
  });
});

describe('claiming emulator ports', () => {
  let dir: string;
  const released: (() => void)[] = [];
  const servers: Server[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emu-ports-'));
  });
  afterEach(async () => {
    released.splice(0).forEach((release) => release());
    await Promise.all(servers.splice(0).map(closeServer));
    rmSync(dir, { recursive: true, force: true });
  });
  const claim = (env: Record<string, string | undefined>, keys: EmuPort[] = ALL, isFree?: (port: number) => boolean) => {
    const result = claimEmuPorts(keys, { env, lockDir: dir, releaseOnExit: false, isFree });
    released.push(result.release);
    return result;
  };

  it('changes nothing when no port setting is present', () => {
    const env: Record<string, string | undefined> = {};
    const result = claim(env);
    expect(result.custom).toBe(false);
    expect(result.ports).toEqual(EMU_PORT_DEFAULT);
    expect(env).toEqual({});
    expect(existsSync(join(dir, 'dryscope-test-emu-port-9399.lock'))).toBe(false);
  });

  it('uses explicit ports, takes the rest from the defaults, and writes them back for child processes', async () => {
    const free = await freeNearby();
    const env: Record<string, string | undefined> = { EMU_AUTH_PORT: String(free) };
    // Whether something on this host already listens on the default firestore port is not what is
    // under test, so that one port counts as free.
    const result = claim(env, ['auth', 'firestore'], (port) => port === EMU_PORT_DEFAULT.firestore || isPortFree(port));
    expect(result.custom).toBe(true);
    expect(result.ports).toEqual({ auth: free, firestore: 8399 });
    expect(env.EMU_AUTH_PORT).toBe(String(free));
    expect(env.EMU_FIRESTORE_PORT).toBe('8399');
  });

  it('refuses an explicit port that something already listens on', async () => {
    const server = await holdPort(await freeNearby());
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    expect(() => claim({ EMU_AUTH_PORT: String(port) }, ['auth'])).toThrow(new RegExp(`EMU_AUTH_PORT.*${port}.*in use`));
  });

  it('refuses an explicit port another run has claimed, until that run lets go', async () => {
    const port = await freeNearby();
    const first = claim({ EMU_AUTH_PORT: String(port) }, ['auth']);
    expect(() => claim({ EMU_AUTH_PORT: String(port) }, ['auth'])).toThrow(/claimed by another/);
    first.release();
    claim({ EMU_AUTH_PORT: String(port) }, ['auth']);
  });

  it('refuses two settings that name the same port', async () => {
    const port = await freeNearby();
    expect(() => claim({ EMU_AUTH_PORT: String(port), EMU_FIRESTORE_PORT: String(port) }, ['auth', 'firestore'])).toThrow(
      /same port/,
    );
  });

  it('picks distinct free ports for every port left unset when EMU_PORTS=auto', () => {
    const env: Record<string, string | undefined> = { EMU_PORTS: 'auto' };
    const { ports } = claim(env);
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(ALL.length);
    for (const key of ALL) {
      expect(ports[key]).not.toBe(EMU_PORT_DEFAULT[key]);
      expect(env[EMU_PORT_ENV[key]]).toBe(String(ports[key]));
    }
    expect(values.every((port) => port >= 20_000 && port < 30_000)).toBe(true);
  });

  it('keeps an explicit port beside the picked ones', async () => {
    const free = await freeNearby();
    const { ports } = claim({ EMU_PORTS: 'auto', EMU_FIRESTORE_PORT: String(free) });
    expect(ports.firestore).toBe(free);
    expect(ports.auth).not.toBe(free);
  });

  it('never gives the same port to two runs that claim at once, and skips a port something listens on', async () => {
    const held = await holdPort(await freeNearby());
    servers.push(held);
    const heldPort = (held.address() as { port: number }).port;
    // A random source that starts on the port that is taken and on the one run A already holds.
    const a = claimEmuPorts(['auth', 'firestore'], {
      env: { EMU_PORTS: 'auto' },
      lockDir: dir,
      releaseOnExit: false,
      candidate: sequence([heldPort, 21_001, 21_002]),
      range: { from: 20_000, to: 30_000 },
    });
    released.push(a.release);
    expect(a.ports).toEqual({ auth: 21_001, firestore: 21_002 });
    const b = claimEmuPorts(['auth', 'firestore'], {
      env: { EMU_PORTS: 'auto' },
      lockDir: dir,
      releaseOnExit: false,
      candidate: sequence([21_001, 21_002, 21_003, 21_004]),
      range: { from: 20_000, to: 30_000 },
    });
    released.push(b.release);
    expect(b.ports).toEqual({ auth: 21_003, firestore: 21_004 });
  });

  it('frees its claims on release so a later run can take the same ports', () => {
    const first = claim({ EMU_PORTS: 'auto' }, ['auth']);
    const port = first.ports.auth!;
    expect(existsSync(join(dir, `dryscope-test-emu-port-${port}.lock`))).toBe(true);
    first.release();
    expect(existsSync(join(dir, `dryscope-test-emu-port-${port}.lock`))).toBe(false);
  });

  it('does not claim again in a process that inherited already-claimed ports (a Playwright worker)', async () => {
    const parent = claim({ EMU_PORTS: 'auto' });
    const inherited: Record<string, string | undefined> = {};
    for (const key of ALL) inherited[EMU_PORT_ENV[key]] = String(parent.ports[key]);
    inherited.EMU_PORTS = 'auto';
    inherited.EMU_PORTS_CLAIMED = '1';
    // The emulators now listen on the claimed ports; a worker must not mistake that for a conflict.
    const listener = await holdPort(parent.ports.auth!);
    servers.push(listener);
    const child = claim(inherited);
    expect(child.ports).toEqual(parent.ports);
  });

  it('knows a port that is in use from one that is free', async () => {
    const port = await freeNearby();
    expect(isPortFree(port)).toBe(true);
    const server = await holdPort(port);
    servers.push(server);
    expect(isPortFree(port)).toBe(false);
  });
});

describe('writing the emulator config for a run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emu-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('copies firebase.json with the run’s ports and an absolute rules path', () => {
    const path = writeEmulatorConfig(
      join(webDir, 'firebase.json'),
      { auth: 21_001, firestore: 21_002, firestoreWebsocket: 21_003, hub: 21_004, logging: 21_005 },
      { dir, removeOnExit: false },
    );
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(path.startsWith(dir)).toBe(true);
    expect(config.emulators.auth).toEqual({ host: '127.0.0.1', port: 21_001 });
    expect(config.emulators.firestore).toEqual({ host: '127.0.0.1', port: 21_002, websocketPort: 21_003 });
    expect(config.emulators.hub).toEqual({ host: '127.0.0.1', port: 21_004 });
    expect(config.emulators.logging).toEqual({ host: '127.0.0.1', port: 21_005 });
    expect(config.emulators.ui).toEqual({ enabled: false });
    expect(config.emulators.singleProjectMode).toBe(true);
    expect(config.firestore.rules).toBe(join(webDir, 'firestore.rules'));
    expect(existsSync(config.firestore.rules)).toBe(true);
  });

  it('does the same for the storage emulator’s config, whose rules sit beside it', () => {
    const base = join(webDir, 'tests/e2e/jobs/storage/firebase.json');
    const path = writeEmulatorConfig(base, { storage: 21_011, hub: 21_012, logging: 21_013 }, { dir, removeOnExit: false });
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.emulators.storage).toEqual({ host: '127.0.0.1', port: 21_011 });
    expect(config.emulators.hub.port).toBe(21_012);
    expect(config.emulators.logging.port).toBe(21_013);
    expect(config.storage.rules).toBe(join(webDir, 'tests/e2e/jobs/storage/storage.rules'));
  });
});

describe('the host lock primitive the claims use', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emu-try-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes a free path once and leaves a held one alone until it is released', () => {
    const path = join(dir, 'lock');
    const release = tryAcquireLock(path);
    expect(release).not.toBeNull();
    expect(tryAcquireLock(path)).toBeNull();
    release!();
    expect(existsSync(path)).toBe(false);
    tryAcquireLock(path)!();
  });

  it('takes over a lock whose holder is gone', async () => {
    const path = join(dir, 'lock');
    await writeFile(path, '2147483646'); // no such process
    const release = tryAcquireLock(path);
    expect(release).not.toBeNull();
    release!();
  });
});

// The runner is started with a stand-in `npx` first on PATH that only records its arguments, as
// tests/unit/emu-guard.test.ts does, so these prove what would reach the Firebase CLI.
describe('npm run test:emu with its own ports', () => {
  let fakeBin: string;
  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), 'dryscope-emu-ports-runner-'));
    // Records its arguments and the config's ports, then stays up a moment as a running emulator would.
    const npx = join(fakeBin, 'npx');
    await writeFile(
      npx,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_RECORD"\ncp "$9" "$FAKE_RECORD.config" 2>/dev/null\nsleep "\${FAKE_HOLD:-0}"\n`,
    );
    await chmod(npx, 0o755);
  });
  afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  function run(env: Record<string, string>, record: string) {
    const full = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_RECORD: record,
      ...env,
    };
    delete (full as Record<string, string | undefined>).EMU_PORTS_CLAIMED;
    return new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/emu/run.ts'], { cwd: webDir, env: full });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
  }

  async function started(record: string) {
    const args = (await readFile(record, 'utf8')).trim().split('\n');
    const configPath = args[args.indexOf('--config') + 1]!;
    return { args, configPath, config: JSON.parse(await readFile(`${record}.config`, 'utf8')) };
  }

  it('hands the Firebase CLI a config with the ports from EMU_*_PORT', async () => {
    const record = join(fakeBin, 'record');
    const auth = await freeNearby();
    const firestore = await freeNearby(auth + 1);
    // The ports left unpinned would be the defaults, and a run beside this one may hold those.
    const ws = await freeNearby(firestore);
    const hub = await freeNearby(ws);
    const logging = await freeNearby(hub);
    const result = await run(
      {
        EMU_AUTH_PORT: String(auth),
        EMU_FIRESTORE_PORT: String(firestore),
        EMU_FIRESTORE_WS_PORT: String(ws),
        EMU_HUB_PORT: String(hub),
        EMU_LOGGING_PORT: String(logging),
      },
      record,
    );
    expect(result.code).toBe(0);
    const { args, configPath, config } = await started(record);
    expect(args.slice(0, 9)).toEqual([
      '--yes',
      'firebase-tools@15.31.0',
      'emulators:exec',
      '--only',
      'auth,firestore',
      '--project',
      'demo-dryscope',
      '--config',
      configPath,
    ]);
    expect(configPath).not.toBe('firebase.json');
    expect(config.emulators.auth.port).toBe(auth);
    expect(config.emulators.firestore.port).toBe(firestore);
    // The temporary config goes away with the run.
    expect(existsSync(configPath)).toBe(false);
  });

  it('gives two runs started together different ports under EMU_PORTS=auto', async () => {
    const [a, b] = [join(fakeBin, 'a'), join(fakeBin, 'b')];
    const [first, second] = await Promise.all([
      run({ EMU_PORTS: 'auto', FAKE_HOLD: '2' }, a),
      run({ EMU_PORTS: 'auto', FAKE_HOLD: '2' }, b),
    ]);
    expect([first.code, second.code]).toEqual([0, 0]);
    const ports = [(await started(a)).config, (await started(b)).config].flatMap((config) => [
      config.emulators.auth.port,
      config.emulators.firestore.port,
      config.emulators.firestore.websocketPort,
      config.emulators.hub.port,
      config.emulators.logging.port,
    ]);
    expect(new Set(ports).size).toBe(10);
  }, 30_000);

  it('does not wait for the host-wide lock when it has its own ports', async () => {
    const record = join(fakeBin, 'record');
    const result = await run({ EMU_PORTS: 'auto' }, record);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/waiting for it to finish/);
  });

  it('exits with a clear message when an explicit port is taken, without starting the Firebase CLI', async () => {
    const record = join(fakeBin, 'record');
    const server = await holdPort(await freeNearby());
    try {
      const port = (server.address() as { port: number }).port;
      const result = await run({ EMU_AUTH_PORT: String(port) }, record);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`EMU_AUTH_PORT.*${port}.*in use`));
      expect(existsSync(record)).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

describe('claimPorts and claimE2ePorts', () => {
  let lockDir: string;

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), 'e2e-ports-'));
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('claims arbitrary named ports with the shared lock mechanism', () => {
    const defaults = { alpha: 4100, beta: 4101 } as const;
    const envNames = { alpha: 'TEST_ALPHA_PORT', beta: 'TEST_BETA_PORT' } as const;
    const env: Record<string, string | undefined> = { EMU_PORTS: 'auto' };
    const claim = claimPorts(['alpha', 'beta'], defaults, envNames, {
      env,
      lockDir,
      releaseOnExit: false,
      candidate: sequence([25_001, 25_001, 25_002]),
      isFree: () => true,
    });
    try {
      expect(claim.custom).toBe(true);
      expect(claim.ports).toEqual({ alpha: 25_001, beta: 25_002 });
      expect(env.TEST_ALPHA_PORT).toBe('25001');
      expect(env.TEST_BETA_PORT).toBe('25002');
      expect(env.EMU_PORTS_CLAIMED).toBe('1');
    } finally {
      claim.release();
    }
  });

  it('claims distinct ports for all 8 emulators and all 4 E2E app servers across concurrent runs', () => {
    expect(E2E_SERVER_PORT_DEFAULT).toEqual({
      app: 3100,
      jobs: 3101,
      appCheck: 3103,
      appCheckJobs: 3104,
    });
    expect(E2E_SERVER_PORT_ENV).toEqual({
      app: 'E2E_APP_PORT',
      jobs: 'E2E_JOBS_PORT',
      appCheck: 'E2E_APP_CHECK_PORT',
      appCheckJobs: 'E2E_APP_CHECK_JOBS_PORT',
    });

    const envA: Record<string, string | undefined> = { EMU_PORTS: 'auto' };
    const envB: Record<string, string | undefined> = { EMU_PORTS: 'auto' };
    const claimA = claimE2ePorts({ env: envA, lockDir, releaseOnExit: false, isFree: () => true });
    const claimB = claimE2ePorts({ env: envB, lockDir, releaseOnExit: false, isFree: () => true });
    try {
      const portsA = Object.values(claimA.ports);
      const portsB = Object.values(claimB.ports);
      expect(portsA).toHaveLength(12);
      expect(portsB).toHaveLength(12);
      expect(new Set([...portsA, ...portsB]).size).toBe(24);
      expect(envA.E2E_APP_CHECK_PORT).toBe(String(claimA.ports.appCheck));
      expect(envA.E2E_APP_CHECK_JOBS_PORT).toBe(String(claimA.ports.appCheckJobs));
      expect(envA.E2E_APP_PORT).toBe(String(claimA.ports.app));
      expect(envA.E2E_JOBS_PORT).toBe(String(claimA.ports.jobs));
    } finally {
      claimA.release();
      claimB.release();
    }
  });

  it('honors explicit E2E server port env vars without modifying them', async () => {
    const appCheckPort = await freeNearby(30_000);
    const appCheckJobsPort = await freeNearby(appCheckPort);
    const env: Record<string, string | undefined> = {
      E2E_APP_CHECK_PORT: String(appCheckPort),
      E2E_APP_CHECK_JOBS_PORT: String(appCheckJobsPort),
    };
    const claim = claimE2ePorts({ env, lockDir, releaseOnExit: false, isFree: () => true });
    try {
      expect(claim.custom).toBe(true);
      expect(claim.ports.appCheck).toBe(appCheckPort);
      expect(claim.ports.appCheckJobs).toBe(appCheckJobsPort);
      expect(claim.ports.app).toBe(3100);
      expect(claim.ports.jobs).toBe(3101);
    } finally {
      claim.release();
    }
  });
});

function sequence(values: number[]): () => number {
  // The ports picking tries, in order, instead of random ones.
  let index = 0;
  return () => values[index++ % values.length]!;
}

// A free port that is not one of the real emulator ports, found by binding port 0 and letting go.
async function freeNearby(minimum = 0): Promise<number> {
  for (;;) {
    const server = await new Promise<Server>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    await closeServer(server);
    if (port > minimum) return port;
  }
}
