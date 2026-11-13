// S7-5 AI evaluation run on `test` (docs/plans/S7.md, S7-5; V9 B). Real models and Model Armor,
// so never in CI: the manual workflow .github/workflows/ai-evals.yml runs it as dryscope-eval-test,
// or the owner runs it with their own `gcloud auth application-default login`. From web/:
//
//   npm run eval:ai -- --feature <suite> [--max-usd <dollars>] [--out <file>]
//
// Suites: summary, job_summary, scope_fill, injection, meter_reading, voice_notes, live. The run cap
// is $2 by default and can only be lowered. It prints one JSON result (counts, scores, model, prompt
// version and cost; no dataset or model text) and exits 0 only when every pass mark is met.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createArmor, createArmorClients } from '../src/lib/ai/armor';
import { parseAiClientConfig, vertexModel } from '../src/lib/ai/client';
import { DATA_DIR } from '../tests/ai-evals/datasets';
import { EvalRefusal, MAX_RUN_MICRO_USD, SUITES, isSuite, runSuite, type Suite } from '../tests/ai-evals/runner';

export const PROJECT = 'dryscope';
// Test's templates only (infra/dryscope/modules/naming): evaluations never touch live.
export const TEXT_TEMPLATE = 'projects/dryscope/locations/us-central1/templates/dryscope-text-test';
export const IMAGE_TEMPLATE = 'projects/dryscope/locations/us/templates/dryscope-image-test';
const ARMOR_TIMEOUT_MS = 10_000;

// The one workflow allowed to run it: ai-evals.yml on master in this repository's own run.
const EVAL_WORKFLOW = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/ai-evals\.yml@refs\/heads\/master$/;

export type EvalOptions = { suite: Suite; capMicroUsd: number; out: string | null };

// Refuses every automated runner except the evaluation workflow, and any unknown argument.
export function parseEvalArgs(argv: string[], env: Record<string, string | undefined>): EvalOptions {
  for (const name of ['K_SERVICE', 'CLOUD_RUN_JOB']) {
    if (env[name]) throw new EvalRefusal(`refusing to run: ${name} is set (evaluations never run on Cloud Run)`);
  }
  if (env.CI || env.GITHUB_ACTIONS) {
    if (!env.GITHUB_ACTIONS || !EVAL_WORKFLOW.test(env.GITHUB_WORKFLOW_REF ?? '')) {
      throw new EvalRefusal('refusing to run: in CI only the AI evaluations workflow (ai-evals.yml on master) may run real models');
    }
  }
  let suite: Suite | undefined;
  let capMicroUsd = MAX_RUN_MICRO_USD;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new EvalRefusal(`missing value for ${flag}`);
    if (flag === '--feature' && suite === undefined) {
      if (!isSuite(value)) throw new EvalRefusal(`--feature must be one of: ${SUITES.join(', ')}`);
      suite = value;
    } else if (flag === '--max-usd') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new EvalRefusal('--max-usd must be dollars, such as 2 or 0.50');
      const [whole, cents = ''] = value.split('.');
      capMicroUsd = Number(whole) * 1_000_000 + Number(cents.padEnd(2, '0')) * 10_000;
      if (capMicroUsd <= 0 || capMicroUsd > MAX_RUN_MICRO_USD) throw new EvalRefusal('--max-usd must be more than 0 and at most 2');
    } else if (flag === '--out' && out === null) {
      out = value;
    } else throw new EvalRefusal(`unknown argument ${flag} (use --feature, --max-usd, --out)`);
  }
  if (!suite) throw new EvalRefusal(`--feature is required: one of ${SUITES.join(', ')}`);
  return { suite, capMicroUsd, out };
}

function readDataFile(relative: string): Uint8Array | null {
  if (!/^[a-z-]+\/[a-z]{2}-\d{2}\.(?:wav|jpg|png)$/.test(relative)) return null;
  try {
    return readFileSync(`${DATA_DIR}${relative}`);
  } catch {
    return null;
  }
}

async function main() {
  const options = parseEvalArgs(process.argv.slice(2), process.env);
  const templates = { text: TEXT_TEMPLATE, image: IMAGE_TEMPLATE };
  const armor = createArmor({ ...createArmorClients(templates), templates, timeoutMs: ARMOR_TIMEOUT_MS });
  const result = await runSuite(options.suite, options.capMicroUsd, {
    model: vertexModel(parseAiClientConfig({ project: PROJECT })),
    armor,
    armorTemplate: options.suite === 'meter_reading' ? IMAGE_TEMPLATE : TEXT_TEMPLATE,
    readFile: readDataFile,
    commit: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA! : null,
  });
  const json = JSON.stringify(result, null, 2);
  if (options.out) writeFileSync(options.out, `${json}\n`);
  console.log(json);
  return result.pass;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (pass) => process.exit(pass ? 0 : 1),
    (error: unknown) => {
      // Only our own refusal messages are shown; anything else could quote a request.
      console.error(error instanceof EvalRefusal ? error.message : 'the evaluation run failed');
      process.exit(2);
    },
  );
}
