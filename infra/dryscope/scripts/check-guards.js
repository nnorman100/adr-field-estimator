#!/usr/bin/env node
'use strict';
// Checks that Terraform itself refuses to destroy every protected resource.
//
// guards/guards.tftest.hcl applies a root against the mock provider and then lets Terraform
// tear it down. Terraform reports "Instance cannot be destroyed" for each resource that has
// lifecycle.prevent_destroy = true, so a resource whose guard was removed or set to false is
// destroyed silently and missing from the report. `terraform test` cannot assert this (the
// refusal is a plain error, not a failing check), and plan JSON does not carry lifecycle
// settings, so the teardown report is the observable evidence.
//
//   terraform test -test-directory=guards -json ... | node check-guards.js <data|app> -
//
// Terraform 1.17 no longer prints that refusal at teardown (the same run passes with nothing
// refused), so the teardown report cannot tell a protected resource from an unprotected one
// there. Given the root's directory as a third argument, the check therefore reads the
// configuration itself: every protected resource must carry lifecycle { prevent_destroy = true }.
// The teardown report is then only a second witness: if this Terraform prints any refusal at
// all, every protected resource must still be refused.
//
//   node check-guards.js <data|app> <stream|-> <root directory>
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// Runs that must pass for the report to mean anything. The app root also proves that a
// later image digest is not planned (Terraform ignores the image after create).
const REQUIRED_RUNS = {
  data: ['create_everything'],
  app: ['create_everything', 'a_different_image_is_not_planned_after_create'],
};

const PROTECTED = {
  data: [
    'google_sql_database_instance.main',
    'google_firestore_database.field',
    'google_storage_bucket.evidence',
    'google_artifact_registry_repository.images',
    'google_secret_manager_secret.app["resend-api-key"]',
    'google_secret_manager_secret.app["stripe-secret-key"]',
    'google_secret_manager_secret.app["maps-api-key"]',
    'google_secret_manager_secret.app["link-signing-key"]',
  ],
  app: [
    'google_cloud_run_v2_service.svc["api"]',
    'google_cloud_run_v2_service.svc["live"]',
    'google_cloud_run_v2_job.migrate',
  ],
};

/** Replaces comments and string contents with spaces so braces inside them are ignored. */
function blank(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (c === '#' || two === '//') {
      while (i < source.length && source[i] !== '\n') out += (i++, ' ');
      i--;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === '"') {
      out += '"';
      for (i++; i < source.length && source[i] !== '"'; i++) {
        if (source[i] === '\\') out += (i++, ' ');
        out += source[i] === '\n' ? '\n' : ' ';
      }
      out += '"';
    } else {
      out += c;
    }
  }
  return out;
}

/** Index just past the brace that closes the one opened at `open`. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Text of `body` with every nested block removed, keeping its own attributes. */
function ownLevel(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') i = closing(body, i) - 1;
    else out += body[i];
  }
  return out;
}

// What a release sets by hand and a later apply must therefore leave alone: each protected
// resource's lifecycle.ignore_changes must name these. Plan JSON cannot show a missing one until
// the day a plan tries to put the old value back, so the configuration is read here instead.
// Cloud Run services: the image and traffic move with releases and rollbacks, and the revision
// name is set by the release workflow (this root never configures it), so a plan that kept it
// out of ignore_changes would clear it in place on the running service.
const REQUIRED_IGNORED = {
  data: {},
  app: {
    'google_cloud_run_v2_service.svc': [
      'template[0].containers[0].image',
      'template[0].revision',
      'traffic',
    ],
    'google_cloud_run_v2_job.migrate': ['template[0].template[0].containers[0].image'],
  },
};

/** The entries of `ignore_changes = [ ... ]` at this level of a lifecycle block (blanked text). */
function ignoredIn(inner) {
  const found = /(^|\s)ignore_changes\s*=\s*\[/.exec(inner);
  if (!found) return [];
  const start = found.index + found[0].length;
  let depth = 1;
  let i = start;
  for (; i < inner.length && depth > 0; i++) {
    if (inner[i] === '[') depth++;
    else if (inner[i] === ']') depth--;
  }
  // Entries are separated by commas outside their own [index] brackets.
  const entries = [];
  let level = 0;
  let current = '';
  for (const c of inner.slice(start, i - 1)) {
    if (c === '[') level++;
    if (c === ']') level--;
    if (c === ',' && level === 0) {
      entries.push(current);
      current = '';
    } else current += c;
  }
  entries.push(current);
  return entries.map((e) => e.replace(/\s+/g, '')).filter(Boolean);
}

/**
 * Maps "type.name" to {guarded, ignored} for every resource in the .tf files of `dir`: whether it
 * has lifecycle { prevent_destroy = true }, and the entries of its lifecycle ignore_changes. A
 * resource with for_each is one block, so one guard covers every key.
 */
function readLifecycles(dir) {
  const guards = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.tf'))) {
    const original = fs.readFileSync(path.join(dir, file), 'utf8');
    const text = blank(original); // same offsets as the original, so names can be read from it
    const header = /^[ \t]*resource[ \t]+"([^"]+)"[ \t]+"([^"]+)"[ \t]*\{/dgm;
    let found;
    while ((found = header.exec(text))) {
      const open = found.index + found[0].length - 1;
      const body = text.slice(open + 1, closing(text, open) - 1);
      let guarded = false;
      let ignored = [];
      // Only a lifecycle block directly inside the resource counts, not one nested deeper.
      for (let i = 0; i < body.length; i++) {
        if (body[i] !== '{') continue;
        const end = closing(body, i);
        if (/(^|\s)lifecycle\s*$/.test(body.slice(0, i))) {
          const inner = ownLevel(body.slice(i + 1, end - 1));
          if (/^[ \t]*prevent_destroy[ \t]*=[ \t]*true[ \t]*$/m.test(inner)) guarded = true;
          ignored = [...ignored, ...ignoredIn(inner)];
        }
        i = end - 1;
      }
      const [[a, b], [c, d]] = [found.indices[1], found.indices[2]];
      guards.set(`${original.slice(a, b)}.${original.slice(c, d)}`, { guarded, ignored });
    }
  }
  return guards;
}

/** Maps "type.name" to whether the resource has lifecycle { prevent_destroy = true }. */
function readGuards(dir) {
  return new Map([...readLifecycles(dir)].map(([name, { guarded }]) => [name, guarded]));
}

/** Problems with the configuration in `dir`, independent of the Terraform version. */
function checkConfig(dir, root) {
  const lifecycles = readLifecycles(dir);
  const guards = readGuards(dir);
  const problems = [];
  for (const [base, required] of Object.entries(REQUIRED_IGNORED[root])) {
    const have = lifecycles.get(base)?.ignored ?? [];
    for (const entry of required) {
      if (!have.includes(entry)) {
        problems.push(
          `${base}: lifecycle.ignore_changes must name ${entry} (a release sets it; an apply would put it back)`,
        );
      }
    }
  }
  for (const address of PROTECTED[root]) {
    const base = address.replace(/\[.*\]$/, '');
    if (!guards.has(base)) problems.push(`${address}: resource ${base} not found in ${dir}`);
    else if (!guards.get(base))
      problems.push(
        `${address}: lifecycle.prevent_destroy = true is missing or false in the configuration`,
      );
  }
  return problems;
}

/**
 * Returns a list of problems found in the JSON line stream of a guards run. With
 * `refusalsOptional`, a stream that has no refusal at all (Terraform 1.17) is accepted; one
 * that has any refusal must still have one for every protected resource.
 */
function checkGuards(lines, root, { refusalsOptional = false } = {}) {
  const problems = [];
  const refused = new Set();
  const passed = new Set();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    const run = doc.test_run;
    if (run && run.progress === 'complete' && run.status === 'pass') passed.add(run.run);
    const diagnostic = doc.diagnostic;
    if (!diagnostic) continue;
    const match = /^Resource (.+?) has lifecycle\.prevent_destroy set/.exec(
      diagnostic.detail ?? '',
    );
    if (diagnostic.summary === 'Instance cannot be destroyed' && match) {
      refused.add(match[1]);
    } else {
      problems.push(`unexpected error: ${diagnostic.summary}`);
    }
  }
  for (const name of REQUIRED_RUNS[root]) {
    if (!passed.has(name))
      problems.push(`run ${name} did not pass, so what it covers was not tested`);
  }
  for (const address of PROTECTED[root]) {
    if (refusalsOptional && refused.size === 0) break;
    if (!refused.has(address)) {
      problems.push(
        `${address}: Terraform did not refuse to destroy it (lifecycle.prevent_destroy missing or false)`,
      );
    }
  }
  return problems;
}

async function main(argv) {
  const [root, file, dir] = argv;
  if (!PROTECTED[root] || !file) {
    console.error('usage: check-guards.js <data|app> <stream|-> [root directory]');
    return 2;
  }
  const input = file === '-' ? process.stdin : fs.createReadStream(file);
  const lines = [];
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity }))
    lines.push(line);
  const problems = [
    ...(dir ? checkConfig(dir, root) : []),
    ...checkGuards(lines, root, { refusalsOptional: Boolean(dir) }),
  ];
  for (const problem of problems) console.error(problem);
  console.log(
    `${root}: ${PROTECTED[root].length} destroy guard(s) checked, ${problems.length} problem(s)`,
  );
  return problems.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  checkGuards,
  checkConfig,
  readGuards,
  readLifecycles,
  PROTECTED,
  REQUIRED_IGNORED,
  REQUIRED_RUNS,
};
