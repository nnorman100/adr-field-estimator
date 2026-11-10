"""CI configuration guards: Python version source, legacy browser scope, deny-all Firestore rules and CI runners."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from ci_python_version import python_version  # noqa: E402


def test_ci_python_version_matches_dockerfile():
    assert re.fullmatch(r'\d+\.\d+', python_version())


@pytest.mark.parametrize(
    'line,expected',
    [
        ('FROM python:3.11-slim@sha256:abc', '3.11'),
        ('FROM python:3.14-slim', '3.14'),
        ('FROM python:3.12.4-slim-bookworm', '3.12'),
        ('FROM --platform=linux/amd64 python:3.13-slim', '3.13'),
    ],
)
def test_python_version_parses_base_image_forms(tmp_path, line, expected):
    dockerfile = tmp_path / 'Dockerfile'
    dockerfile.write_text(f'{line}\nWORKDIR /app\n')
    assert python_version(dockerfile) == expected


@pytest.mark.parametrize(
    'content',
    [
        '',
        'FROM debian:12\n',
        'FROM python:latest\n',
        'FROM python:3.11-slim\nFROM python:3.12-slim\n',
    ],
)
def test_python_version_fails_when_unparseable(tmp_path, content):
    dockerfile = tmp_path / 'Dockerfile'
    dockerfile.write_text(content)
    with pytest.raises(ValueError):
        python_version(dockerfile)


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', text)


def test_firebase_json_points_at_rules_file():
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['firestore']['rules'] == 'firestore.rules'
    assert (ROOT / 'firestore.rules').is_file()


def test_firestore_rules_deny_all_client_access():
    """Structural check; all data access must go through the backend's service account."""
    rules = strip_comments((ROOT / 'firestore.rules').read_text())
    assert re.findall(r'\bmatch\s+(/\S+)\s*\{', rules) == [
        '/databases/{database}/documents',
        '/{document=**}',
    ]
    allows = re.findall(r'\ballow\s+([^:;]+?)\s*(?::\s*if\s+([^;]+?))?\s*;', rules)
    assert allows, 'rules must explicitly deny'
    for methods, condition in allows:
        assert condition == 'false', f'allow {methods} must be unconditionally false'
    assert {m.strip() for methods, _ in allows for m in methods.split(',')} == {'read', 'write'}
    assert len(re.findall(r'\ballow\b', rules)) == len(allows)
    assert 'function' not in rules and 'request.auth' not in rules


def load_ci_workflow():
    return yaml.safe_load((ROOT / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8'))


def test_ci_browser_job_gates_steps_on_legacy_scope():
    workflow = load_ci_workflow()
    triggers = workflow.get('on') or workflow.get(True)
    assert set(triggers) == {'push', 'pull_request'}
    assert triggers['push']['branches'] == ['master']

    browser = workflow['jobs']['browser']
    assert 'if' not in browser, 'browser is a required check and must report on every PR'
    assert browser['timeout-minutes'] == 90

    steps = browser['steps']
    assert steps[0]['uses'].startswith('actions/checkout@')
    assert steps[0]['with']['fetch-depth'] == 0
    assert steps[1]['id'] == 'scope'
    assert 'if' not in steps[1]


_EXPR_TOKEN = re.compile(r"(\|\||&&|==|!=|!|\(|\))|'((?:[^']|'')*)'|([A-Za-z_][\w.-]*)")
_STATUS_FUNCTIONS = {'always', 'success', 'failure', 'cancelled'}


def evaluate_step_condition(condition, scope_outputs, job_failed):
    """Evaluate a GitHub Actions step `if:` for the expression subset this workflow uses."""
    expr = condition.strip()
    if expr.startswith('${{') and expr.endswith('}}'):
        expr = expr[3:-2].strip()
    tokens, pos = [], 0
    while pos < len(expr):
        if expr[pos].isspace():
            pos += 1
            continue
        match = _EXPR_TOKEN.match(expr, pos)
        assert match, f'unsupported expression syntax in {condition!r}'
        op, string, ident = match.groups()
        if op:
            tokens.append(('op', op))
        elif string is not None:
            tokens.append(('str', string.replace("''", "'")))
        else:
            tokens.append(('id', ident))
        pos = match.end()

    context = {'steps': {'scope': {'outputs': scope_outputs}}}
    called = set()
    index = 0

    def peek():
        return tokens[index] if index < len(tokens) else (None, None)

    def take(expected=None):
        nonlocal index
        token = peek()
        assert token != (None, None), f'unexpected end of {condition!r}'
        assert expected is None or token == expected, f'expected {expected} in {condition!r}'
        index += 1
        return token

    def truthy(value):
        return value not in (None, False, '', 0)

    def equal(left, right):
        left, right = ('' if left is None else left), ('' if right is None else right)
        if isinstance(left, str) and isinstance(right, str):
            return left.casefold() == right.casefold()
        return left == right

    def parse_or():
        value = parse_and()
        while peek() == ('op', '||'):
            take()
            right = parse_and()
            value = value if truthy(value) else right
        return value

    def parse_and():
        value = parse_compare()
        while peek() == ('op', '&&'):
            take()
            right = parse_compare()
            value = right if truthy(value) else value
        return value

    def parse_compare():
        value = parse_unary()
        while peek() in (('op', '=='), ('op', '!=')):
            negate = take()[1] == '!='
            value = equal(value, parse_unary()) != negate
        return value

    def parse_unary():
        if peek() == ('op', '!'):
            take()
            return not truthy(parse_unary())
        return parse_primary()

    def parse_primary():
        kind, value = take()
        if (kind, value) == ('op', '('):
            inner = parse_or()
            take(('op', ')'))
            return inner
        if kind == 'str':
            return value
        assert kind == 'id', f'unexpected token {value!r} in {condition!r}'
        if peek() == ('op', '('):
            take()
            take(('op', ')'))
            assert value in _STATUS_FUNCTIONS, f'unsupported function {value}() in {condition!r}'
            called.add(value)
            return {
                'always': True,
                'success': not job_failed,
                'failure': job_failed,
                'cancelled': False,
            }[value]
        if value in ('true', 'false', 'null'):
            return {'true': True, 'false': False, 'null': None}[value]
        resolved = context
        for part in value.split('.'):
            resolved = resolved.get(part) if isinstance(resolved, dict) else None
        return resolved

    result = truthy(parse_or())
    assert index == len(tokens), f'trailing tokens in {condition!r}'
    if not called:
        result = result and not job_failed
    return result


@pytest.mark.parametrize(
    'scope_outputs', [{'run': 'true'}, {'run': 'false'}, {}], ids=['run', 'skip', 'missing']
)
@pytest.mark.parametrize('job_failed', [False, True], ids=['job-ok', 'job-failed'])
def test_ci_browser_steps_run_only_when_scope_selects_suite(scope_outputs, job_failed):
    steps = load_ci_workflow()['jobs']['browser']['steps']
    in_scope = scope_outputs.get('run') == 'true'
    for step in steps[2:]:
        uploads_results = step.get('uses', '').startswith('actions/upload-artifact@')
        expected = in_scope and (uploads_results or not job_failed)
        runs = evaluate_step_condition(step.get('if', 'success()'), scope_outputs, job_failed)
        assert runs == expected, step.get('name') or step.get('uses') or step.get('run')


def run_browser_scope_step(repo, event_name, base_sha, github_output):
    workflow = load_ci_workflow()
    script = workflow['jobs']['browser']['steps'][1]['run']
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


def init_scope_repo(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    for cmd in (
        ['git', 'init'],
        ['git', 'config', 'user.email', 'test@example.invalid'],
        ['git', 'config', 'user.name', 'Test'],
    ):
        subprocess.run(cmd, cwd=repo, check=True, capture_output=True)
    (repo / 'README.md').write_text('init\n', encoding='utf-8')
    subprocess.run(['git', 'add', 'README.md'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'init'], cwd=repo, check=True, capture_output=True)
    base_sha = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    return repo, base_sha


@pytest.mark.parametrize('event_name', ['pull_request', 'push'])
@pytest.mark.parametrize(
    'changed_paths',
    [
        [
            'web/src/app/page.tsx',
            'web/package.json',
            'web/package-lock.json',
            'web/playwright.config.ts',
        ],
        ['infra/dryscope/app/main.tf', 'tests/fixtures/terraform/app-test.plan.json'],
        ['docs/RUNBOOK.md', 'README.md', 'RELEASES.md'],
    ],
)
def test_ci_browser_scope_skips_unrelated_changes(tmp_path, event_name, changed_paths):
    repo, base_sha = init_scope_repo(tmp_path)
    for rel in changed_paths:
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'change'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, event_name, base_sha, output_file)
    assert 'Skipping legacy browser suite' in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=false'


@pytest.mark.parametrize('event_name', ['pull_request', 'push'])
@pytest.mark.parametrize(
    'legacy_path',
    [
        '.github/workflows/ci.yml',
        'backend/main.py',
        'backend/requirements.txt',
        'public/app.js',
        'index.html',
        'tests/browser/walk-first.spec.js',
        'tests/browser_server.py',
        'tests/browser-auth.js',
        'tests/fakes.py',
        'playwright.config.js',
        'playwright.isolated.config.js',
        'package.json',
        'package-lock.json',
        'firebase.json',
        'firestore.rules',
        'firestore.indexes.json',
        'scripts/artifact-paths.js',
        'scripts/ci_python_version.py',
        'scripts/manual_chrome.js',
        'scripts/verify_routing.js',
    ],
)
def test_ci_browser_scope_runs_when_legacy_files_change(tmp_path, event_name, legacy_path):
    repo, base_sha = init_scope_repo(tmp_path)
    target = repo / legacy_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'legacy'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, event_name, base_sha, output_file)
    assert legacy_path in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=true'


@pytest.mark.parametrize(
    'missing_base',
    [
        '',
        '0000000000000000000000000000000000000000',
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ],
)
def test_ci_browser_scope_runs_when_base_commit_unavailable(tmp_path, missing_base):
    repo, _ = init_scope_repo(tmp_path)
    target = repo / 'web' / 'src' / 'index.ts'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'web only'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, 'push', missing_base, output_file)
    assert 'unavailable; running legacy browser suite' in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=true'


def test_ci_browser_scope_runs_when_push_base_is_not_ancestor(tmp_path):
    repo, base_sha = init_scope_repo(tmp_path)
    target = repo / 'web' / 'src' / 'index.ts'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'diverged'], cwd=repo, check=True, capture_output=True)
    diverged_sha = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    subprocess.run(['git', 'reset', '--hard', base_sha], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, 'push', diverged_sha, output_file)
    assert 'not an ancestor of HEAD; running legacy browser suite' in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=true'


# The Actions budget stop blocks GitHub-hosted jobs, so every job defaults to the self-hosted pool
# and the repository variable CI_RUNNER (for example ubuntu-latest) switches it back. See
# docs/runbook/ci.md, "CI runners".
RUNNER = "${{ vars.CI_RUNNER || 'dryscope-linux' }}"
WORKFLOWS = sorted((ROOT / '.github' / 'workflows').glob('*.y*ml'))


def workflow_jobs(path):
    return yaml.safe_load(path.read_text(encoding='utf8'))['jobs'].items()


def test_workflows_exist():
    assert {path.name for path in WORKFLOWS} >= {
        'ci.yml',
        'codeql.yml',
        'deploy.yml',
        'test-guard.yml',
        'web.yml',
    }


@pytest.mark.parametrize('path', WORKFLOWS, ids=lambda path: path.name)
def test_every_job_runs_on_the_switchable_runner(path):
    for name, job in workflow_jobs(path):
        assert job.get('runs-on') == RUNNER, f'{path.name} job {name}'
        # The self-hosted job container has no Docker daemon for service or job containers.
        assert 'services' not in job and 'container' not in job, f'{path.name} job {name}'


def test_python_job_installs_node():
    """Some Python tests run node and skip without it; the self-hosted container has none."""
    jobs = dict(workflow_jobs(ROOT / '.github' / 'workflows' / 'ci.yml'))
    uses = [step.get('uses', '') for step in jobs['python']['steps']]
    assert any(use.startswith('actions/setup-node@') for use in uses)


def test_codeql_sets_up_node_before_init():
    """CodeQL's JavaScript/TypeScript extractor needs node; the self-hosted container has none."""
    jobs = dict(workflow_jobs(ROOT / '.github' / 'workflows' / 'codeql.yml'))
    uses = [step.get('uses', '') for step in jobs['analyze']['steps']]
    node = [i for i, use in enumerate(uses) if use.startswith('actions/setup-node@')]
    init = [i for i, use in enumerate(uses) if use.startswith('github/codeql-action/init@')]
    assert node and init and node[0] < init[0]
