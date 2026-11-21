"""The shared legacy scope script, which no workflow calls any more, and ci.yml.

As of 2026-11-10 the legacy Python suite, the legacy Playwright browser suite and the legacy
Firestore emulator tests are retired from CI and their jobs are removed from ci.yml. The CodeQL
workflow that last called scripts/ci_legacy_scope.sh is removed too (D-037). The DryScope rebuild's checks (web/, infra/dryscope, required docs, file
length, test guard, audit) must keep running on every PR.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

from tests.test_ci_config import init_scope_repo, load_ci_workflow

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'ci_legacy_scope.sh'
SCOPE_RUN = 'bash scripts/ci_legacy_scope.sh'


def load_workflow(name):
    return yaml.safe_load((ROOT / '.github' / 'workflows' / name).read_text(encoding='utf-8'))


def run_scope(repo, event_name, base_sha, github_output, suite='legacy checks'):
    env = {
        **os.environ,
        'SUITE': suite,
        'EVENT_NAME': event_name,
        'BASE_SHA': base_sha,
        'GITHUB_OUTPUT': str(github_output),
    }
    return subprocess.run(
        ['bash', str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True, check=True
    )


def commit_files(repo, paths, message='change'):
    for rel in paths:
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', message], cwd=repo, check=True, capture_output=True)


@pytest.mark.parametrize('event_name', ['pull_request', 'push'])
@pytest.mark.parametrize(
    'changed_paths',
    [
        [
            'web/src/app/page.tsx',
            'web/package.json',
            'web/package-lock.json',
            'web/migrations/0002.sql',
        ],
        ['infra/dryscope/app/main.tf', 'infra/dryscope/fixtures/app-test.plan.json'],
        [
            'tests/fixtures/terraform/app-test.plan.json',
            'tests/fixtures/terraform/data-live.plan.json',
        ],
        ['docs/RUNBOOK.md', 'docs/STATUS.md', 'docs/roadmap.md', 'README.md', 'RELEASES.md'],
        ['web/README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore'],
    ],
    ids=['web', 'infra', 'legacy-terraform-fixtures', 'docs', 'repo-notes'],
)
def test_scope_skips_rebuild_and_doc_only_changes(tmp_path, event_name, changed_paths):
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, changed_paths)
    output = tmp_path / 'github_output.txt'
    result = run_scope(repo, event_name, base_sha, output, suite='legacy Python tests')
    assert (
        'Skipping legacy Python tests: no legacy app, test or tooling files changed'
        in result.stdout
    )
    assert output.read_text(encoding='utf-8').strip() == 'run=false'


@pytest.mark.parametrize('event_name', ['pull_request', 'push'])
@pytest.mark.parametrize(
    'legacy_path',
    [
        # The browser job's own list.
        '.github/workflows/ci.yml',
        'backend/main.py',
        'backend/requirements.txt',
        'public/app.js',
        'index.html',
        'tests/browser/walk-first.spec.js',
        'tests/browser_server.py',
        'tests/fakes.py',
        'playwright.config.js',
        'package.json',
        'package-lock.json',
        'firebase.json',
        '.firebaserc',
        'firestore.rules',
        'firestore.indexes.json',
        'scripts/ci_python_version.py',
        # Unit-test and tooling files.
        '.github/workflows/web.yml',
        '.github/workflows/codeql.yml',
        'tests/test_backend.py',
        'tests/test_frontend.js',
        'tests/test_firestore_emulator.py',
        'tests/fixtures/readiness.json',
        'tests/fixtures/pricing-oracle/cases/v1-cent-one.json',
        'scripts/auto_deploy.py',
        'scripts/ci_legacy_scope.sh',
        'scripts/file_length_baselines.json',
        'ops/vault-backup/vault_backup.py',
        'docs/ai-inventory.md',
        'docs/pricing-source.md',
        'pyproject.toml',
        'eslint.config.js',
        'vitest.config.mjs',
        '.prettierrc.json',
        'some/new/module.py',
    ],
)
def test_scope_runs_when_legacy_files_change(tmp_path, event_name, legacy_path):
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, [legacy_path])
    output = tmp_path / 'github_output.txt'
    result = run_scope(repo, event_name, base_sha, output)
    assert legacy_path in result.stdout
    assert output.read_text(encoding='utf-8').strip() == 'run=true'


def test_scope_runs_when_legacy_and_rebuild_files_change_together(tmp_path):
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, ['web/src/app/page.tsx', 'docs/RUNBOOK.md', 'backend/claims.py'])
    output = tmp_path / 'github_output.txt'
    result = run_scope(repo, 'pull_request', base_sha, output)
    assert 'backend/claims.py' in result.stdout
    assert 'web/src' not in result.stdout
    assert output.read_text(encoding='utf-8').strip() == 'run=true'


@pytest.mark.parametrize('event_name', ['push', 'schedule', 'pull_request'])
@pytest.mark.parametrize(
    'missing_base',
    ['', '0000000000000000000000000000000000000000', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    ids=['empty', 'zeros', 'unknown-commit'],
)
def test_scope_runs_when_base_commit_unavailable(tmp_path, event_name, missing_base):
    """New branches, force pushes and the weekly CodeQL schedule have no diff base."""
    repo, _ = init_scope_repo(tmp_path)
    commit_files(repo, ['web/src/index.ts'])
    output = tmp_path / 'github_output.txt'
    result = run_scope(repo, event_name, missing_base, output, suite='the legacy checks')
    assert 'unavailable; running the legacy checks' in result.stdout
    assert output.read_text(encoding='utf-8').strip() == 'run=true'


def test_scope_runs_when_push_base_is_not_ancestor(tmp_path):
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, ['web/src/index.ts'], 'diverged')
    diverged = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    subprocess.run(['git', 'reset', '--hard', base_sha], cwd=repo, check=True, capture_output=True)
    output = tmp_path / 'github_output.txt'
    result = run_scope(repo, 'push', diverged, output)
    assert 'not an ancestor of HEAD; running' in result.stdout
    assert output.read_text(encoding='utf-8').strip() == 'run=true'


# --- Workflow wiring -------------------------------------------------------------------------


def check_scope_step(step, suite=None):
    assert step['id'] == 'scope'
    assert step['run'] == SCOPE_RUN
    assert step['env']['EVENT_NAME'] == '${{ github.event_name }}'
    base = step['env']['BASE_SHA']
    assert 'github.event.pull_request.base.sha' in base and 'github.event.before' in base
    if suite:
        assert step['env']['SUITE'] == suite


def test_ci_node_job_lint_still_covers_required_docs_and_file_length():
    import json

    lint = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']['lint']
    assert 'check-file-length.mts' in lint and 'check_required_docs.js' in lint


def scope_gated_parts(workflow):
    """Jobs and steps that run the scope script or gate on its output."""
    gated = []
    for job_name, job in workflow['jobs'].items():
        if 'steps.scope.' in job.get('if', ''):
            gated.append(job_name)
        for step in job.get('steps', []):
            label = f'{job_name}: {step.get("name") or step.get("uses") or step.get("run")}'
            runs_script = 'scripts/ci_legacy_scope.sh' in step.get('run', '').split()
            if step.get('id') == 'scope' or runs_script or 'steps.scope.' in step.get('if', ''):
                gated.append(label)
    return gated


def run_commands(job):
    return [step.get('run', '') for step in job['steps']]


@pytest.mark.parametrize('job_name', ['python', 'browser', 'firestore-emulator'])
def test_ci_has_no_legacy_test_jobs(job_name):
    """The legacy suites are removed, not faked: the owner drops these names from the ruleset."""
    assert job_name not in load_ci_workflow()['jobs']


def test_ci_node_job_keeps_the_rebuild_checks_on_every_pull_request():
    job = load_ci_workflow()['jobs']['node']
    assert 'if' not in job
    assert all('if' not in step for step in job['steps'])
    runs = run_commands(job)
    for command in ('npm ci', 'npm run format:check', 'npm run lint', 'npx vitest run'):
        assert command in runs
    assert 'npm test' not in runs, 'the legacy unit tests in npm test are retired from CI'
    lint = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']['lint']
    assert 'check-file-length.mts' in lint and 'check_required_docs.js' in lint


def test_ci_keeps_node_and_audit_and_nothing_is_scoped():
    workflow = load_ci_workflow()
    assert set(workflow['jobs']) == {'node', 'audit'}
    for name in ('ci.yml', 'test-guard.yml', 'web.yml'):
        assert scope_gated_parts(load_workflow(name)) == [], f'{name} must not use the scope step'
    audit = workflow['jobs']['audit']
    assert 'if' not in audit and all('if' not in step for step in audit['steps'])
