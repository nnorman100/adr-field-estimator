"""CI configuration guards: Python version source, legacy browser scope and deny-all Firestore rules."""

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
    assert triggers['push']['branches'] == ['master']
    assert 'pull_request' in triggers
    assert 'workflow_dispatch' in triggers

    browser = workflow['jobs']['browser']
    assert 'if' not in browser, 'browser is a required check and must report on every PR'
    assert browser['timeout-minutes'] == 90

    steps = browser['steps']
    assert steps[0]['uses'].startswith('actions/checkout@')
    assert steps[0]['with']['fetch-depth'] == 0
    assert steps[1]['id'] == 'scope'
    for step in steps[2:]:
        assert "steps.scope.outputs.run == 'true'" in step.get('if', '')


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
def test_ci_browser_scope_skips_unrelated_pr_changes(tmp_path, changed_paths):
    repo, base_sha = init_scope_repo(tmp_path)
    for rel in changed_paths:
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'change'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, 'pull_request', base_sha, output_file)
    assert 'Skipping legacy browser suite' in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=false'


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
def test_ci_browser_scope_runs_when_legacy_files_change(tmp_path, legacy_path):
    repo, base_sha = init_scope_repo(tmp_path)
    target = repo / legacy_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'legacy'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, 'pull_request', base_sha, output_file)
    assert legacy_path in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=true'


@pytest.mark.parametrize('event_name', ['push', 'workflow_dispatch'])
def test_ci_browser_scope_always_runs_on_push_and_manual_dispatch(tmp_path, event_name):
    repo, base_sha = init_scope_repo(tmp_path)
    target = repo / 'web' / 'src' / 'index.ts'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('changed\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'web only'], cwd=repo, check=True, capture_output=True)

    output_file = tmp_path / 'github_output.txt'
    result = run_browser_scope_step(repo, event_name, base_sha, output_file)
    assert f'event is {event_name}' in result.stdout
    assert output_file.read_text(encoding='utf-8').strip() == 'run=true'
