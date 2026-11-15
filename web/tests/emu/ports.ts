// Per-run ports for the Firebase emulators, so test runs on one machine never fight over them.
//
// Left alone, the emulators use the fixed ports in firebase.json (auth 9399, firestore 8399) and
// the Firebase CLI's own defaults for the rest (hub 4400, logging 4500, firestore websocket 9150),
// and a second run fails with "Port 9399 is not open ... could not start Authentication Emulator".
// Two settings change that; with neither present nothing here does anything and the defaults stay:
//   EMU_AUTH_PORT, EMU_FIRESTORE_PORT, EMU_FIRESTORE_WS_PORT, EMU_HUB_PORT, EMU_LOGGING_PORT
//     (and for the browser tests' Storage emulator EMU_STORAGE_PORT, EMU_STORAGE_HUB_PORT,
//     EMU_STORAGE_LOGGING_PORT) pin a port.
//   EMU_PORTS=auto picks a free port for every one that is not pinned.
// Every port a run uses is claimed with a lock file (lock.ts, one per port) so runs that start at
// the same moment cannot pick the same one, and checked for a listener so a port something else
// already holds is skipped (picked) or refused (pinned). The Firebase CLI has no port flag, so a
// run with its own ports gets a temporary copy of the config with them in it (`writeEmulatorConfig`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { tryAcquireLock } from './lock';

export type EmuPort =
  | 'auth'
  | 'firestore'
  | 'firestoreWebsocket'
  | 'hub'
  | 'logging'
  | 'storage'
  | 'storageHub'
  | 'storageLogging';

export const EMU_PORT_ENV: Record<EmuPort, string> = {
  auth: 'EMU_AUTH_PORT',
  firestore: 'EMU_FIRESTORE_PORT',
  firestoreWebsocket: 'EMU_FIRESTORE_WS_PORT',
  hub: 'EMU_HUB_PORT',
  logging: 'EMU_LOGGING_PORT',
  storage: 'EMU_STORAGE_PORT',
  storageHub: 'EMU_STORAGE_HUB_PORT',
  storageLogging: 'EMU_STORAGE_LOGGING_PORT',
};

// firebase.json (auth, firestore), tests/e2e/jobs/storage/firebase.json (storage and its hub and
// logging) and the Firebase CLI's own defaults for what those files leave out. A unit test pins
// the first two against the files.
export const EMU_PORT_DEFAULT: Record<EmuPort, number> = {
  auth: 9399,
  firestore: 8399,
  firestoreWebsocket: 9150,
  hub: 4400,
  logging: 4500,
  storage: 9499,
  storageHub: 4499,
  storageLogging: 4599,
};

export const AUTO_ENV = 'EMU_PORTS';
// Set once a process has claimed its ports, for the processes it starts (Playwright's workers
// load the config again): they read the ports from the environment and claim nothing.
export const CLAIMED_ENV = 'EMU_PORTS_CLAIMED';
// Picked ports come from here: above the usual dev-server ports, below Linux's ephemeral range,
// and clear of every default above, so a picking run never races a run on the defaults.
const PICK_RANGE = { from: 20_000, to: 30_000 };
const PICK_ATTEMPTS = 500;

type Env = Record<string, string | undefined>;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

function parsePort(name: string, value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1024 && port <= 65_535)) throw new Error(`${name} must be a port from 1024 to 65535, not ${JSON.stringify(value)}`);
  return port;
}

function readPort(name: string, fallback: number, env: Env): number {
  const value = env[name];
  return isSet(value) ? parsePort(name, value) : fallback;
}

// The port a process should use: the pinned one when the variable is set, else the default.
export function emuPort(key: EmuPort, env: Env = process.env): number {
  return readPort(EMU_PORT_ENV[key], EMU_PORT_DEFAULT[key], env);
}

// Nothing listens on the port, on IPv4 or IPv6 loopback (the emulator hub opens both). Asks a
// short-lived node process because binding is asynchronous and Playwright loads its config
// synchronously.
const FREE_SCRIPT = `
const net = require('node:net');
const port = Number(process.argv[1]);
const hosts = ['127.0.0.1', '::1'];
const next = (i) => {
  if (i === hosts.length) process.exit(0);
  const server = net.createServer();
  // No IPv6 on this machine is not a conflict; anything else that stops the bind is.
  server.once('error', (error) => (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' ? next(i + 1) : process.exit(1)));
  server.listen(port, hosts[i], () => server.close(() => next(i + 1)));
};
next(0);
`;

export function isPortFree(port: number): boolean {
  try {
    execFileSync(process.execPath, ['-e', FREE_SCRIPT, String(port)], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export type ClaimOptions = {
  env?: Env;
  // Where the per-port lock files go; the host's temp directory by default.
  lockDir?: string;
  // Let go of the claims when the process exits (default), or only on `release()`.
  releaseOnExit?: boolean;
  isFree?: (port: number) => boolean;
  // Where picking looks, and (for tests) a replacement for its random choice of port.
  range?: { from: number; to: number };
  candidate?: () => number;
};

export type Claim<K extends string = EmuPort> = {
  ports: Record<K, number>;
  // False when no port setting was present: the defaults are in use and nothing was claimed.
  custom: boolean;
  release: () => void;
};

// Settles the ports for `keys` from the environment and claims them. With no port setting this
// returns the defaults and changes nothing. Otherwise it writes every port back into `env`
// (with CLAIMED_ENV) for the processes it starts.
export function claimPorts<K extends string>(
  keys: readonly K[],
  defaults: Readonly<Record<K, number>>,
  envNames: Readonly<Record<K, string>>,
  options: ClaimOptions = {},
): Claim<K> {
  const env = options.env ?? process.env;
  const auto = env[AUTO_ENV];
  if (isSet(auto) && auto !== 'auto') throw new Error(`${AUTO_ENV} must be "auto" or unset, not ${JSON.stringify(auto)}`);
  const pinned = keys.filter((key) => isSet(env[envNames[key]]));
  const custom = isSet(auto) || pinned.length > 0 || isSet(env[CLAIMED_ENV]);
  const ports = {} as Record<K, number>;
  if (!custom || isSet(env[CLAIMED_ENV])) {
    for (const key of keys) ports[key] = readPort(envNames[key], defaults[key], env);
    return { ports, custom, release: () => {} };
  }

  const isFree = options.isFree ?? isPortFree;
  const lockDir = options.lockDir ?? tmpdir();
  const range = options.range ?? PICK_RANGE;
  const candidate = options.candidate ?? (() => range.from + Math.floor(Math.random() * (range.to - range.from)));
  const held: (() => void)[] = [];
  const release = () => held.splice(0).forEach((unlock) => unlock());
  const lockPath = (port: number) => join(lockDir, `dryscope-test-emu-port-${port}.lock`);
  // One port, taken for good or not at all: a lock file nobody else holds and no listener.
  const take = (port: number): 'ok' | 'claimed' | 'in use' => {
    const unlock = tryAcquireLock(lockPath(port));
    if (!unlock) return 'claimed';
    if (!isFree(port)) {
      unlock();
      return 'in use';
    }
    held.push(unlock);
    return 'ok';
  };

  try {
    const wanted = keys.map((key) => ({ key, name: envNames[key], pinned: isSet(env[envNames[key]]) }));
    // Pinned ports first (and defaults, for the ones a run leaves alone without asking for picks),
    // so picking cannot take one of them.
    const fixed = wanted.filter((one) => one.pinned || !isSet(auto));
    const seen = new Map<number, string>();
    for (const one of fixed) {
      const port = readPort(one.name, defaults[one.key], env);
      const other = seen.get(port);
      if (other) throw new Error(`${other} and ${one.name} name the same port (${port})`);
      seen.set(port, one.name);
      const outcome = take(port);
      if (outcome === 'claimed') {
        throw new Error(`${one.name}=${port}: port ${port} is claimed by another test run (lock ${lockPath(port)})`);
      }
      if (outcome === 'in use') {
        throw new Error(
          `${one.name}=${port}: port ${port} is already in use on this machine; pin another port or set ${AUTO_ENV}=auto`,
        );
      }
      ports[one.key] = port;
    }
    for (const one of wanted.filter((one) => !fixed.includes(one))) {
      let picked: number | null = null;
      for (let attempt = 0; attempt < PICK_ATTEMPTS && picked === null; attempt += 1) {
        const port = candidate();
        if (!seen.has(port) && take(port) === 'ok') picked = port;
      }
      if (picked === null) throw new Error(`${one.name}: found no free port in ${range.from}-${range.to - 1} after ${PICK_ATTEMPTS} tries`);
      seen.set(picked, one.name);
      ports[one.key] = picked;
    }
  } catch (error) {
    release();
    throw error;
  }

  for (const key of keys) env[envNames[key]] = String(ports[key]);
  env[CLAIMED_ENV] = '1';
  if (options.releaseOnExit ?? true) process.once('exit', release);
  return { ports, custom, release };
}

export function claimEmuPorts<K extends EmuPort>(keys: readonly K[], options: ClaimOptions = {}): Claim<K> {
  return claimPorts(keys, EMU_PORT_DEFAULT, EMU_PORT_ENV, options);
}

export type ConfigPorts = { auth?: number; firestore?: number; firestoreWebsocket?: number; storage?: number; hub?: number; logging?: number };

export type ConfigOptions = { dir?: string; removeOnExit?: boolean };

// A temporary copy of the firebase.json at `basePath` with these ports in it, and its rules files
// given as absolute paths (the CLI reads them relative to the config's own folder). Returns the
// copy's path; it goes away when the process exits.
export function writeEmulatorConfig(basePath: string, ports: ConfigPorts, options: ConfigOptions = {}): string {
  const baseDir = dirname(resolve(basePath));
  type Section = { host?: string; rules?: string } & Record<string, unknown>;
  const config = JSON.parse(readFileSync(basePath, 'utf8')) as { emulators?: Record<string, Section> } & Record<string, Section | undefined>;
  const emulators = (config.emulators ??= {});
  const setPort = (name: string, port: number | undefined, extra: Record<string, number> = {}) => {
    if (port === undefined) return;
    emulators[name] = { ...emulators[name], host: emulators[name]?.host ?? '127.0.0.1', port, ...extra };
  };
  setPort('auth', ports.auth);
  setPort('firestore', ports.firestore, ports.firestoreWebsocket === undefined ? {} : { websocketPort: ports.firestoreWebsocket });
  setPort('storage', ports.storage);
  setPort('hub', ports.hub);
  setPort('logging', ports.logging);
  for (const name of ['firestore', 'storage']) {
    const section = config[name];
    if (section && typeof section.rules === 'string') section.rules = resolve(baseDir, section.rules);
  }
  const dir = mkdtempSync(join(options.dir ?? tmpdir(), 'dryscope-emu-config-'));
  const path = join(dir, 'firebase.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  if (options.removeOnExit ?? true) process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return path;
}
