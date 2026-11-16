#!/usr/bin/env node
// Run daily by .github/workflows/ci-budget.yml (one short job a day, not one per pull request: the
// pool has two places). It reads the pull-request runs of the last day; a job that ran longer than its
// budget opens the issue "CI budget exceeded: <job>" (or comments on the open one),
// so an agent makes it fast again instead of the budget creeping up (docs/runbook/ci.md, "Fast pull
// requests, full suite after merge"). Only the job's own run time counts, not time in the queue.
import { pathToFileURL } from 'node:url';

// Minutes. The fast required checks hold to five; the risky-area suites (only on pull requests that
// touch them) get what they need today. Raise a budget only with the owner.
export const BUDGET_MINUTES = {
  node: 3,
  audit: 2,
  'test-guard': 2,
  'company-isolation': 5,
  check: 5,
  'pr-database': 8,
  'pr-e2e': 20,
};

const baseName = (name) => String(name).replace(/ \(\d+\)$/, '');
export const budgetFor = (name) => BUDGET_MINUTES[baseName(name)];
export const issueTitle = (name) => `CI budget exceeded: ${baseName(name)}`;

/** Finished jobs (passed or failed) that ran longer than their budget. */
export function overBudget(jobs) {
  const over = [];
  for (const job of jobs) {
    if (!['success', 'failure'].includes(job.conclusion)) continue;
    const budget = budgetFor(job.name);
    if (!budget || !job.started_at || !job.completed_at) continue;
    const minutes = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000;
    if (minutes > budget) over.push({ name: job.name, minutes, budget, url: job.html_url });
  }
  return over;
}

async function api(method, route, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}`);
  return res.json();
}

export const WATCHED = ['CI', 'Test guard', 'Web app', 'Web PR database', 'Web PR e2e'];

/** One entry per job over budget: how often, and the slowest run. */
export function summarize(over) {
  const byJob = new Map();
  for (const o of over) {
    const key = issueTitle(o.name);
    const prev = byJob.get(key);
    if (!prev) byJob.set(key, { ...o, count: 1 });
    else {
      prev.count += 1;
      if (o.minutes > prev.minutes) Object.assign(prev, { minutes: o.minutes, url: o.url });
    }
  }
  return [...byJob.entries()].map(([title, o]) => ({ title, ...o }));
}

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 19);
  const { workflow_runs: runs } = await api(
    'GET',
    `/actions/runs?event=pull_request&status=completed&created=%3E%3D${since}&per_page=100`,
  );
  const jobs = [];
  for (const run of runs.filter((r) => WATCHED.includes(r.name))) {
    jobs.push(...(await api('GET', `/actions/runs/${run.id}/jobs?per_page=100`)).jobs);
  }
  const summary = summarize(overBudget(jobs));
  console.log(`${jobs.length} pull-request job(s) in the last day, ${summary.length} over budget`);
  if (!summary.length) return;
  const open = await api('GET', '/issues?state=open&per_page=100');
  for (const job of summary) {
    const text =
      `In the last day ${job.count} run(s) of ${baseName(job.name)} went over its ${job.budget}-minute ` +
      `budget; the slowest took ${job.minutes.toFixed(1)} minutes: ${job.url}\n\n` +
      'Make the job fast again (fewer or faster tests, less setup); do not raise the budget or ' +
      'weaken a test (AGENTS.md hard rule 1).';
    const existing = open.find((i) => !i.pull_request && i.title === job.title);
    if (existing) await api('POST', `/issues/${existing.number}/comments`, { body: text });
    else await api('POST', '/issues', { title: job.title, body: text });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
