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
const fs = require('node:fs');
const readline = require('node:readline');

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
  app: ['google_cloud_run_v2_service.svc["api"]', 'google_cloud_run_v2_service.svc["live"]'],
};

/** Returns a list of problems found in the JSON line stream of a guards run. */
function checkGuards(lines, root) {
  const problems = [];
  const refused = new Set();
  let applied = false;
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
    if (run && run.progress === 'complete' && run.run === 'create_everything') {
      applied = run.status === 'pass';
    }
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
  if (!applied) problems.push('the mocked apply of the root did not pass, so nothing was tested');
  for (const address of PROTECTED[root]) {
    if (!refused.has(address)) {
      problems.push(
        `${address}: Terraform did not refuse to destroy it (lifecycle.prevent_destroy missing or false)`,
      );
    }
  }
  return problems;
}

async function main(argv) {
  const [root, file] = argv;
  if (!PROTECTED[root] || !file) {
    console.error('usage: check-guards.js <data|app> <stream|->');
    return 2;
  }
  const input = file === '-' ? process.stdin : fs.createReadStream(file);
  const lines = [];
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity }))
    lines.push(line);
  const problems = checkGuards(lines, root);
  for (const problem of problems) console.error(problem);
  console.log(
    `${root}: ${PROTECTED[root].length} destroy guard(s) checked, ${problems.length} problem(s)`,
  );
  return problems.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { checkGuards, PROTECTED };
