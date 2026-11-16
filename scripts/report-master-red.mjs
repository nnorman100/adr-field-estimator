#!/usr/bin/env node
// Run by .github/workflows/master-red.yml when a CI, Web app or CodeQL run on master fails. It
// opens the issue "master is red: <workflow>" (or comments on the one already open), so a red master
// is never silent; the pull request that fixes it closes it ("Fixes #N"). Fix forward
// (docs/runbook/ci.md, "Fast pull requests, full suite after merge"). Green runs start no job.
import { pathToFileURL } from 'node:url';

export const TITLE_PREFIX = 'master is red: ';

/** What to do with a finished run: open (or update) the issue, or nothing. */
export function decide({ conclusion, event, branch }) {
  // Pushes, and the weekly CodeQL scan (a schedule runs on master).
  if (!['push', 'schedule'].includes(event) || branch !== 'master') return 'skip';
  return conclusion === 'failure' || conclusion === 'timed_out' ? 'open' : 'skip';
}

export const issueTitle = (workflow) => `${TITLE_PREFIX}${workflow}`;

export function failureText({ workflow, url, sha }) {
  if (workflow === 'CodeQL') {
    return [
      `CodeQL found at least one security finding on master at ${sha.slice(0, 12)}: ${url}`,
      '',
      "The findings are listed in that run's summary. Fix them with a new pull request and close",
      'this issue from it ("Fixes #<this issue>"). Releases are not blocked. A finding that is a',
      "false positive is excluded only with the owner's approval, like any check (AGENTS.md rule 1).",
    ].join('\n');
  }
  return [
    `The ${workflow} run on master failed at ${sha.slice(0, 12)}: ${url}`,
    '',
    'Nothing is released until master is green again. Fix forward with a new pull request',
    '(docs/runbook/ci.md, "Fast pull requests, full suite after merge") and close this issue',
    'from that pull request ("Fixes #<this issue>").',
  ].join('\n');
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
