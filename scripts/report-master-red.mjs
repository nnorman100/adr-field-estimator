#!/usr/bin/env node
// Run by .github/workflows/master-red.yml after a CI or Web app run on a push to master. A failed
// run opens an issue "master is red: <workflow>" (or comments on the one already open), so a red
// master is never silent; the next green run closes it. Fix forward (docs/runbook/ci.md, "Fast pull
// requests, full suite after merge"). Cancelled and skipped runs change nothing.
import { pathToFileURL } from 'node:url';

export const TITLE_PREFIX = 'master is red: ';

/** What to do with a finished run: open (or update) the issue, close it, or nothing. */
export function decide({ conclusion, event, branch }) {
  if (event !== 'push' || branch !== 'master') return 'skip';
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'open';
  if (conclusion === 'success') return 'close';
  return 'skip';
}

export const issueTitle = (workflow) => `${TITLE_PREFIX}${workflow}`;

export function failureText({ workflow, url, sha }) {
  return [
    `The ${workflow} run on master failed at ${sha.slice(0, 12)}: ${url}`,
    '',
    'Nothing is released until master is green again. Fix forward with a new pull request',
    '(docs/runbook/ci.md, "Fast pull requests, full suite after merge"); this issue closes',
    `itself when the next ${workflow} run on master passes.`,
  ].join('\n');
}

export const greenText = ({ workflow, url, sha }) =>
  `${workflow} passed on master again at ${sha.slice(0, 12)}: ${url}`;

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

async function main() {
  const run = {
    workflow: process.env.WORKFLOW_NAME,
    url: process.env.RUN_URL,
    sha: process.env.HEAD_SHA ?? '',
  };
  const action = decide({
    conclusion: process.env.CONCLUSION,
    event: process.env.RUN_EVENT,
    branch: process.env.HEAD_BRANCH,
  });
  console.log(`${run.workflow}: ${process.env.CONCLUSION} -> ${action}`);
  if (action === 'skip') return;

  const open = await api('GET', '/issues?state=open&per_page=100');
  const existing = open.find((i) => !i.pull_request && i.title === issueTitle(run.workflow));
  if (action === 'open') {
    if (existing)
      await api('POST', `/issues/${existing.number}/comments`, { body: failureText(run) });
    else await api('POST', '/issues', { title: issueTitle(run.workflow), body: failureText(run) });
  } else if (existing) {
    await api('POST', `/issues/${existing.number}/comments`, { body: greenText(run) });
    await api('PATCH', `/issues/${existing.number}`, { state: 'closed' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
