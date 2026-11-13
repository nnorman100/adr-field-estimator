// S7-0 calibration probes on `test` (docs/plans/S7.md, S7-0 and owner step A). Owner-run only:
// never in CI, never by the release workflow, never against live. From web/, with your own
// `gcloud auth application-default login` and a one-hour roles/iam.serviceAccountTokenCreator grant
// on the relay's test account:
//
//   npm run probe:live -- --impersonate dryscope-live-test@dryscope.iam.gserviceaccount.com
//
// It opens Gemini Live sessions as dryscope-live-test (impersonated from your ADC), calls Model
// Armor streaming sanitize, and reads back the spike template and the floor setting with your own
// credentials. It prints only measurements, yes/no answers and short fixed codes: never a token,
// session handle, transcript, audio, prompt or email (formatLine refuses anything else). It runs
// about 32 minutes, because question (f) waits 2, 10 and 30 minutes before resuming a handle.
// The results go in the S7-0 note (docs/plans/S7.md section 13).
import { pathToFileURL } from 'node:url';
import {
  createArmorStreamClient,
  createLiveDialer,
  probeConnect,
  probeHandleAge,
  probeIdleBilling,
  probeResumeAndVoice,
  probeSanitizeLatency,
  takeHandle,
  type ArmorStreamClient,
  type LiveDialer,
  type SanitizeLatency,
} from '../src/lib/ai/live-probe';

export const PROJECT = 'dryscope';
export const LIVE_TEST_ACCOUNT = 'dryscope-live-test@dryscope.iam.gserviceaccount.com';
export const SPIKE_TEMPLATE = 'projects/dryscope/locations/us-central1/templates/dryscope-live-spike';
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

// A refusal or usage error of our own; its message is safe to show.
export class ProbeArgsError extends Error {}

// The plan's calibration: (f) resumes after 2, 10 and 30 minutes; (d) idles for 60 seconds.
export const RESUME_MINUTES = [2, 10, 30] as const;
export const IDLE_SECONDS = 60;

export type ProbeOptions = { impersonate: string };

// The project is always dryscope. Takes only --impersonate, and refuses any account but the relay's
// test account, any other argument and any automated runner: the probe runs under the relay's
// identity and is the owner's to run.
export function parseProbeArgs(argv: string[], env: Record<string, string | undefined>): ProbeOptions {
  for (const name of ['CI', 'GITHUB_ACTIONS', 'K_SERVICE', 'CLOUD_RUN_JOB']) {
    if (env[name]) throw new ProbeArgsError(`refusing to run: ${name} is set (the probe is owner-run only, never automated)`);
  }
  const [flag, impersonate, ...rest] = argv;
  if (flag !== '--impersonate' || rest.length > 0) {
    throw new ProbeArgsError('unknown argument (the only argument is --impersonate <account>)');
  }
  if (impersonate !== LIVE_TEST_ACCOUNT) throw new ProbeArgsError(`refusing to run: --impersonate must be ${LIVE_TEST_ACCOUNT}`);
  return { impersonate };
}

// ---------- output: measurements only ----------

export type SafeValue = number | boolean | null | string;
const CODE = /^[a-z][a-z0-9_.-]{0,47}$/;
// A Google permission name, e.g. aiplatform.customJobs.create: the one mixed-case value allowed.
const PERMISSION = /^(?:aiplatform|iam|modelarmor|resourcemanager|serviceusage)\.[a-z][a-zA-Z]{1,40}\.[a-z][a-zA-Z]{1,40}$/;
const LABEL = /^[a-z][a-z0-9_]{0,63}(?:_(?:aiplatform|iam|modelarmor|resourcemanager|serviceusage)\.[a-z][a-zA-Z]{1,40}\.[a-z][a-zA-Z]{1,40})?$/;

// One printed line. Strings must be short lowercase codes (yes, permission_denied) or a Google
// permission name (aiplatform.endpoints.predict); anything else is refused, so a handle, token, email, transcript
// or error message can never reach the terminal.
export function formatLine(question: string, key: string, value: SafeValue): string {
  if (!/^\([a-h]\)$/.test(question) || !LABEL.test(key)) throw new Error('probe output refused: bad label');
  let shown: string;
  if (value === null) shown = 'n/a';
  else if (typeof value === 'boolean') shown = value ? 'yes' : 'no';
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('probe output refused: not a finite number');
    shown = String(value);
  } else if (CODE.test(value) || PERMISSION.test(value)) shown = value;
  else throw new Error('probe output refused: not a fixed code');
  return `${question} ${key}: ${shown}`;
}

export function formatRecord(question: string, record: Record<string, SafeValue>, prefix = ''): string[] {
  return Object.entries(record).map(([key, value]) => formatLine(question, `${prefix}${key}`, value));
}

// ---------- the run ----------

export type ProbePorts = {
  dialer: LiveDialer | null; // null: impersonation failed
  impersonation: string; // 'ok' or an error code
  liveTestArmor: ArmorStreamClient;
  ownerArmor: ArmorStreamClient;
  testPermissions: () => Promise<Record<string, boolean> | string>;
  readOwner: (url: string) => Promise<{ status: number; body: unknown }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : value === undefined ? false : null);
const statusOf = (error: unknown): number => {
  const e = error as { status?: unknown; response?: { status?: unknown } } | null;
  return Number(e?.status ?? e?.response?.status ?? 0);
};
const httpCode = (status: number) =>
  status === 404 ? 'not_found' : status === 403 ? 'permission_denied' : status === 401 ? 'unauthenticated' : `http_${status}`;

// (h): what the spike left, read back with the owner's own credentials (owner step B).
async function readBack(ports: ProbePorts): Promise<string[]> {
  const out: string[] = [];
  const template = await ports.readOwner(`https://modelarmor.us-central1.rep.googleapis.com/v1/${SPIKE_TEMPLATE}`);
  if (template.status === 200) {
    const meta = ((template.body as { templateMetadata?: Record<string, unknown> }) ?? {}).templateMetadata ?? {};
    out.push(formatLine('(h)', 'spike_template_exists', true));
    out.push(formatLine('(h)', 'spike_template_log_sanitize_operations', flag(meta.logSanitizeOperations)));
    out.push(formatLine('(h)', 'spike_template_log_template_operations', flag(meta.logTemplateOperations)));
  } else out.push(formatLine('(h)', 'spike_template_exists', httpCode(template.status)));
  const floor = await ports.readOwner(`https://modelarmor.googleapis.com/v1/projects/${PROJECT}/locations/global/floorSetting`);
  if (floor.status === 200) {
    const body = (floor.body ?? {}) as { enableFloorSettingEnforcement?: unknown; aiPlatformFloorSetting?: Record<string, unknown> };
    out.push(formatLine('(h)', 'floor_setting_read', true));
    out.push(formatLine('(h)', 'floor_setting_enforcement', flag(body.enableFloorSettingEnforcement)));
    out.push(formatLine('(h)', 'floor_setting_cloud_logging', flag(body.aiPlatformFloorSetting?.enableCloudLogging)));
  } else out.push(formatLine('(h)', 'floor_setting_read', httpCode(floor.status)));
  return out;
}

// (g): streaming sanitize as the relay's test account; if Model Armor refuses that account (S7-2's
// modelarmor.user is not applied yet), the latency is measured again with the owner's credentials.
async function sanitize(ports: ProbePorts): Promise<string[]> {
  const out: string[] = [];
  const show = (who: string, r: SanitizeLatency) => {
    const { direction, ...rest } = r;
    out.push(...formatRecord('(g)', rest, `${who}_${direction}_`));
  };
  for (const direction of ['prompt', 'response'] as const) {
    const asTest = await probeSanitizeLatency(ports.liveTestArmor, SPIKE_TEMPLATE, direction);
    show('as_live_test', asTest);
    if (asTest.error === 'permission_denied' || asTest.error === 'unauthenticated') {
      show('as_owner', await probeSanitizeLatency(ports.ownerArmor, SPIKE_TEMPLATE, direction));
    }
  }
  return out;
}

export async function runProbe(ports: ProbePorts, print: (line: string) => void): Promise<void> {
  print(formatLine('(e)', 'concurrent_session_quota', 'owner_reads_quotas_page'));
  print(formatLine('(a)', 'impersonation', ports.impersonation));

  const dialer = ports.dialer;
  if (dialer) {
    const held = await ports.testPermissions();
    if (typeof held === 'string') print(formatLine('(a)', 'test_iam_permissions', held));
    else for (const [permission, yes] of Object.entries(held)) print(formatLine('(a)', `holds_${permission}`, yes));
    const connect = await probeConnect(dialer, ports.now);
    for (const line of formatRecord('(a)', connect, 'live_')) print(line);

    if (connect.connected) {
      // (f) handles are taken first, so their clocks run while the other probes do.
      const handles = await Promise.all(
        RESUME_MINUTES.map(async () => ({ handle: await takeHandle(dialer), closedAt: ports.now() })),
      );
      const aged = Promise.all(
        RESUME_MINUTES.map(async (minutes, i) => {
          const { handle, closedAt } = handles[i]!;
          await ports.sleep(Math.max(0, closedAt + minutes * 60_000 - ports.now()));
          const result = await probeHandleAge(dialer, handle, minutes);
          return { ...result, waited_minutes: Math.round(((ports.now() - closedAt) / 60_000) * 10) / 10 };
        }),
      );
      const { b, c } = await probeResumeAndVoice(dialer);
      for (const line of formatRecord('(b)', b, 'live_')) print(line);
      for (const line of formatRecord('(c)', c)) print(line);
      const idle = await probeIdleBilling(dialer, { idleSeconds: IDLE_SECONDS, sleep: ports.sleep });
      for (const line of formatRecord('(d)', idle)) print(line);
      for (const line of await sanitize(ports)) print(line);
      for (const line of await readBack(ports)) print(line);
      for (const result of await aged) {
        const { minutes, ...rest } = result;
        for (const line of formatRecord('(f)', rest, `after_${minutes}_min_`)) print(line);
      }
      return;
    }
  }
  // Without a Live session, (b) online, (c), (d) and (f) cannot run; (g) and (h) still can.
  for (const line of await sanitize(ports)) print(line);
  for (const line of await readBack(ports)) print(line);
}

// ---------- real ports ----------

async function realPorts(options: ProbeOptions): Promise<ProbePorts> {
  const { GoogleAuth, Impersonated } = await import('google-auth-library');
  let owner: Awaited<ReturnType<InstanceType<typeof GoogleAuth>['getClient']>>;
  try {
    owner = await new GoogleAuth({ scopes: [CLOUD_PLATFORM] }).getClient();
  } catch {
    throw new ProbeArgsError('refusing to run: no Google credentials; run gcloud auth application-default login');
  }
  const liveTest = new Impersonated({
    sourceClient: owner,
    targetPrincipal: options.impersonate,
    targetScopes: [CLOUD_PLATFORM],
    delegates: [],
    lifetime: 3600,
  });
  let impersonation = 'ok';
  try {
    await liveTest.getAccessToken();
  } catch (error) {
    impersonation = httpCode(statusOf(error));
  }
  const ownerArmor = createArmorStreamClient({ template: SPIKE_TEMPLATE, authClient: owner });
  const liveTestArmor = createArmorStreamClient({ template: SPIKE_TEMPLATE, authClient: liveTest });
  return {
    dialer: impersonation === 'ok' ? createLiveDialer({ project: PROJECT, authClient: liveTest }) : null,
    impersonation,
    liveTestArmor,
    ownerArmor,
    // Which of these the impersonated account holds on the project: predict, and two that
    // roles/aiplatform.user would add, to show the custom role is still predict-only.
    async testPermissions() {
      const permissions = ['aiplatform.endpoints.predict', 'aiplatform.customJobs.create', 'aiplatform.endpoints.get'];
      try {
        const res = await liveTest.request<{ permissions?: string[] }>({
          url: `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT}:testIamPermissions`,
          method: 'POST',
          data: { permissions },
        });
        const held = new Set(res.data.permissions ?? []);
        return Object.fromEntries(permissions.map((p) => [p, held.has(p)]));
      } catch (error) {
        return httpCode(statusOf(error));
      }
    },
    async readOwner(url) {
      try {
        const res = await owner.request({ url, method: 'GET' });
        return { status: res.status, body: res.data };
      } catch (error) {
        return { status: statusOf(error), body: null };
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2), process.env);
  console.log(`S7-0 probe on ${PROJECT}: about ${Math.max(...RESUME_MINUTES) + 2} minutes. Prints measurements only.`);
  await runProbe(await realPorts(options), (line) => console.log(line));
  console.log('Done. Copy these lines into the S7-0 note, then remove your token-creator grant.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      // Only our own refusal messages are shown; anything else could quote a request.
      const message = error instanceof ProbeArgsError ? error.message : 'the probe failed';
      console.error(message);
      process.exit(1);
    },
  );
}
