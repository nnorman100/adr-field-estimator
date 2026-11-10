"""Legacy CI jobs report on every PR but only do their work when legacy app files change.

The browser job's own scope step (#264) is covered in test_ci_config.py. This file covers the
shared script the Python, Firestore emulator, node and CodeQL Python jobs use, and the way those
jobs gate their steps on it. The DryScope rebuild's checks (web/, infra/dryscope, required docs,
file length, test guard, audit) must keep running on every PR.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

from tests.test_ci_config import evaluate_step_condition, init_scope_repo, load_ci_workflow

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'ci_legacy_scope.sh'
SCOPE_RUN = 'bash scripts/ci_legacy_scope.sh'


def load_workflow(name):
    return yaml.safe_load((ROOT / '.github' / 'workflows' / name).read_text(encoding='utf-8'))


def script_paths():
    """Pathspecs in the script's legacy_paths array, in order, comments and quotes removed."""
    text = SCRIPT.read_text(encoding='utf-8')
    body = re.search(r'legacy_paths=\(\n(.*?)\n\)', text, re.DOTALL).group(1)
    lines = [line.strip() for line in body.splitlines()]
    return [line.strip("'") for line in lines if line and not line.startswith('#')]


def browser_paths():
    """Pathspecs in the browser job's inline scope step, in order."""
    script = load_ci_workflow()['jobs']['browser']['steps'][1]['run']
    body = script.split('"$BASE_SHA...HEAD" -- \\\n', 1)[1].split(')"; then', 1)[0]
    return [line.strip().removesuffix('\\').strip().strip("'") for line in body.splitlines()]


def test_script_list_starts_with_the_browser_job_list():
    """One legacy path list: the script extends the browser job's list and never redefines it."""
    browser = browser_paths()
    assert len(browser) > 15
    assert script_paths()[: len(browser)] == browser


def test_script_adds_unit_test_and_tooling_files_after_the_browser_list():
    extras = script_paths()[len(browser_paths()) :]
    for path in ('tests/', 'scripts/', '.github/', 'ops/', ':(glob)**/*.py', 'pyproject.toml'):
        assert path in extras
    # Rebuild paths must never be listed.
    for path in extras:
        assert not path.startswith(('web/', 'infra/', 'docs/RUNBOOK', 'docs/STATUS'))


def run_browser_inline_scope(repo, event_name, base_sha, github_output):
    script = load_ci_workflow()['jobs']['browser']['steps'][1]['run']
    env = {
        **os.environ,
        'EVENT_NAME': event_name,
        'BASE_SHA': base_sha,
        'GITHUB_OUTPUT': str(github_output),
    }
    return subprocess.run(
        ['bash', '-euo', 'pipefail', '-c', script],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )


def example_file(pathspec):
    """A concrete, non-Python file that a pathspec from the list matches."""
    if pathspec.startswith(':(glob)'):
        return pathspec.removeprefix(':(glob)').replace('*', '')
    return pathspec + 'example.txt' if pathspec.endswith('/') else pathspec


@pytest.mark.parametrize('pathspec', browser_paths())
def test_script_and_browser_step_both_run_for_every_browser_path(tmp_path, pathspec):
    """Behavioral drift check: whatever the browser step runs for, the shared script runs for."""
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, [example_file(pathspec)])
    for runner in (run_browser_inline_scope, run_scope):
        output = tmp_path / f'{runner.__name__}.txt'
        runner(repo, 'pull_request', base_sha, output)
        assert output.read_text(encoding='utf-8').strip() == 'run=true', (runner.__name__, pathspec)


def test_script_and_browser_step_both_skip_rebuild_paths(tmp_path):
    repo, base_sha = init_scope_repo(tmp_path)
    commit_files(repo, ['web/src/a.ts', 'infra/dryscope/app/main.tf', 'docs/RUNBOOK.md'])
    for runner in (run_browser_inline_scope, run_scope):
        output = tmp_path / f'{runner.__name__}.txt'
        runner(repo, 'push', base_sha, output)
        assert output.read_text(encoding='utf-8').strip() == 'run=false', runner.__name__


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
        'docs/adr-pricing-source.md',
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

SCOPED_JOBS = {
    'python': 'legacy Python tests',
    'firestore-emulator': 'legacy Firestore emulator tests',
    'node': 'legacy JavaScript tests',
}


def check_scope_step(step, suite=None):
    assert step['id'] == 'scope'
    assert step['run'] == SCOPE_RUN
    assert step['env']['EVENT_NAME'] == '${{ github.event_name }}'
    base = step['env']['BASE_SHA']
    assert 'github.event.pull_request.base.sha' in base and 'github.event.before' in base
    if suite:
        assert step['env']['SUITE'] == suite


@pytest.mark.parametrize('job_name,suite', SCOPED_JOBS.items())
def test_ci_legacy_jobs_always_report_and_run_the_scope_step_first(job_name, suite):
    job = load_ci_workflow()['jobs'][job_name]
    assert 'if' not in job, f'{job_name} is a required check and must report on every PR'
    steps = job['steps']
    assert steps[0]['uses'].startswith('actions/checkout@')
    assert steps[0]['with']['fetch-depth'] == 0
    check_scope_step(steps[1], suite)
    assert 'if' not in steps[1]


@pytest.mark.parametrize('scope_outputs', [{'run': 'true'}, {'run': 'false'}, {}])
@pytest.mark.parametrize('job_failed', [False, True], ids=['job-ok', 'job-failed'])
@pytest.mark.parametrize('job_name', ['python', 'firestore-emulator'])
def test_ci_python_jobs_do_nothing_unless_scope_selects_them(job_name, scope_outputs, job_failed):
    steps = load_ci_workflow()['jobs'][job_name]['steps']
    expected = scope_outputs.get('run') == 'true' and not job_failed
    for step in steps[2:]:
        label = step.get('name') or step.get('uses') or step.get('run')
        assert 'if' in step, f'{job_name}: {label} runs without checking the scope'
        assert evaluate_step_condition(step['if'], scope_outputs, job_failed) == expected, label


def test_ci_python_jobs_keep_their_real_work():
    jobs = load_ci_workflow()['jobs']
    py_runs = [s.get('run', '') for s in jobs['python']['steps']]
    assert 'python -m pytest tests -q -p no:cacheprovider' in py_runs
    assert 'python -m ruff format --check .' in py_runs
    assert 'python -m ruff check .' in py_runs
    emulator = ' '.join(s.get('run', '') for s in jobs['firestore-emulator']['steps'])
    assert 'emulators:exec --only firestore --project demo-adr-emulator' in emulator
    assert 'tests/test_firestore_emulator*.py' in emulator
    assert jobs['firestore-emulator']['env']['ADR_FIRESTORE_EMULATOR_REQUIRED'] == '1'


@pytest.mark.parametrize('scope_outputs', [{'run': 'true'}, {'run': 'false'}, {}])
def test_ci_node_job_keeps_rebuild_checks_always_on(scope_outputs):
    steps = load_ci_workflow()['jobs']['node']['steps']
    by_run = {s['run']: s for s in steps if 'run' in s}
    always = ['npm ci', 'npm run format:check', 'npm run lint']
    for command in always:
        assert 'if' not in by_run[command], f'{command} must run on every PR'
    in_scope = scope_outputs.get('run') == 'true'
    # Legacy unit tests only in scope; otherwise vitest alone, which holds the Terraform plan check.
    assert evaluate_step_condition(by_run['npm test']['if'], scope_outputs, False) == in_scope
    assert evaluate_step_condition(by_run['npx vitest run']['if'], scope_outputs, False) == (
        not in_scope
    )


def test_ci_node_job_lint_still_covers_required_docs_and_file_length():
    import json

    lint = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']['lint']
    assert 'check_file_length.py' in lint and 'check_required_docs.js' in lint


def test_ci_rebuild_and_policy_jobs_are_not_scoped():
    workflow = load_ci_workflow()
    audit = workflow['jobs']['audit']
    assert 'if' not in audit and all('scope' not in str(s) for s in audit['steps'])
    for name in ('test-guard.yml', 'web.yml'):
        text = (ROOT / '.github' / 'workflows' / name).read_text(encoding='utf-8')
        assert 'ci_legacy_scope' not in text, f'{name} must keep running unscoped'


def codeql_condition(step, language):
    condition = step['if'].replace('matrix.language', f"'{language}'")
    return lambda outputs: evaluate_step_condition(condition, outputs, False)


@pytest.mark.parametrize('language', ['python', 'javascript-typescript'])
@pytest.mark.parametrize('scope_outputs', [{'run': 'true'}, {'run': 'false'}, {}])
def test_codeql_scopes_only_the_python_analysis(language, scope_outputs):
    job = load_workflow('codeql.yml')['jobs']['analyze']
    assert 'if' not in job, 'both Analyze checks are required and must report on every PR'
    assert job['strategy']['matrix']['language'] == ['javascript-typescript', 'python']
    steps = job['steps']
    assert steps[0]['uses'].startswith('actions/checkout@')
    # A plain 0 (full history) for both legs: an expression such as `&& 0 || 1` would evaluate to 1
    # because 0 is falsy, giving a shallow clone that lacks the base commit and defeats the skip.
    assert steps[0]['with']['fetch-depth'] == 0
    check_scope_step(steps[1], 'CodeQL Python analysis')
    assert steps[1]['if'] == "matrix.language == 'python'"
    for step in steps[2:]:
        label = step.get('name') or step.get('uses')
        runs = codeql_condition(step, language)(scope_outputs)
        if language == 'javascript-typescript':
            assert runs, f'{label} must always run for JavaScript/TypeScript'
        else:
            assert runs == (scope_outputs.get('run') == 'true'), label
    uses = [s.get('uses', '') for s in steps]
    assert any(u.startswith('github/codeql-action/init@') for u in uses)
    assert any(u.startswith('github/codeql-action/analyze@') for u in uses)


def test_codeql_still_runs_weekly_and_on_pushes():
    triggers = load_workflow('codeql.yml')
    triggers = triggers.get('on') or triggers.get(True)
    assert triggers['schedule'] == [{'cron': '23 9 * * 1'}]
    assert triggers['push']['branches'] == ['master']
