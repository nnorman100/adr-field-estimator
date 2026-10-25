"""ops/monitoring/setup-monitoring.sh stays inside this project and matches the logs the backend writes."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'ops' / 'monitoring' / 'setup-monitoring.sh'
PROJECT = 'alert-disaster-field-2026'


def script_text():
    return SCRIPT.read_text(encoding='utf-8')


def log_fields():
    source = (ROOT / 'backend' / 'cloud_log.py').read_text(encoding='utf-8')
    block = re.search(r'LOG_FIELDS = frozenset\((.*?)\n\)', source, re.S).group(1)
    return set(re.findall(r"'([a-z_]+)'", block))


def test_script_targets_only_this_project():
    text = script_text()
    assert re.findall(r'^PROJECT=(\S+)', text, re.M) == [PROJECT]
    # Every gcloud call goes through helpers that append the project; no other project flag or ID.
    assert set(re.findall(r'--project="?\$?(\w+)', text)) == {'PROJECT'}
    assert 'mitigation-project' not in text and 'alert-disaster-live' not in text
    # Only these account-level checks may omit the project; they read nothing about any project.
    exempt = ('gcloud beta --help', 'gcloud auth list', 'gcloud projects describe "$PROJECT"')
    for line in text.splitlines():
        code = line.strip()
        if (
            code.startswith(('#', 'printf', 'echo'))
            or 'die ' in code
            or not re.search(r'(?<![\w-])gcloud\b', code)
        ):
            continue
        assert '--project="$PROJECT"' in code or any(item in code for item in exempt), line


def test_script_matches_the_deployed_service():
    text = script_text()
    rewrite = json.loads((ROOT / 'firebase.json').read_text(encoding='utf-8'))['hosting']
    rewrite = next(r for r in rewrite['rewrites'] if r['source'] == '/api/**')['run']
    assert f'SERVICE={rewrite["serviceId"]}' in text
    assert f'SERVICE_REGION={rewrite["region"]}' in text
    assert f'HOST={PROJECT}.web.app' in text
    assert 'UPTIME_PATH=/api/health' in text
    assert "@app.get('/api/health')" in (ROOT / 'backend' / 'main.py').read_text(encoding='utf-8')


def test_script_hard_codes_no_address_and_takes_flags():
    text = script_text()
    assert not re.search(r'EMAIL=[\'"]?[\w.+-]+@', text)
    assert '--email' in text and '--dry-run' in text
    assert re.findall(r'[\w.+-]+@[\w-]+\.[a-z]{2,}', text.replace('you@example.com', '')) == []


def test_log_alerts_use_only_allowlisted_fields_and_real_messages():
    text = script_text()
    fields = set(re.findall(r'jsonPayload\.([a-z_]+)', text))
    assert fields >= {'message', 'operation', 'status'}
    assert fields - {'message'} <= log_fields()
    backend = ''.join(path.read_text(encoding='utf-8') for path in (ROOT / 'backend').glob('*.py'))
    for message in re.findall(r'jsonPayload\.message=\\"([^"\\]+)\\"', text):
        assert f"'{message}'" in backend, message
    for operation in re.findall(r'jsonPayload\.operation=\\"([^"\\]+)\\"', text):
        assert f"operation='{operation}'" in backend, operation
    for status in re.findall(r'jsonPayload\.status=\\"([^"\\]+)\\"', text):
        assert f"'{status}'" in backend, status


@pytest.mark.skipif(shutil.which('bash') is None, reason='bash is not installed')
def test_dry_run_makes_no_gcloud_call_and_writes_valid_policies(tmp_path):
    fake = tmp_path / 'bin'
    fake.mkdir()
    marker = tmp_path / 'called'
    (fake / 'gcloud').write_text(f'#!/bin/sh\ntouch {marker}\nexit 1\n')
    (fake / 'gcloud').chmod(0o755)
    configs = tmp_path / 'configs'
    result = subprocess.run(
        [
            'bash',
            str(SCRIPT),
            '--email',
            'owner@example.com',
            '--dry-run',
            '--config-dir',
            str(configs),
        ],
        capture_output=True,
        text=True,
        env={'PATH': f'{fake}:/usr/bin:/bin'},
    )
    assert result.returncode == 0, result.stderr
    assert not marker.exists()
    assert result.stdout.count('--project=alert-disaster-field-2026') >= 7
    policies = sorted(configs.glob('policy-*.json'))
    assert len(policies) == 5
    for path in policies:
        policy = json.loads(path.read_text(encoding='utf-8'))
        assert policy['displayName'].startswith('DryScope: ')
        assert policy['notificationChannels']


def test_script_requires_an_email_and_rejects_a_bad_one():
    if shutil.which('bash') is None:
        pytest.skip('bash is not installed')
    for args in ([], ['--email', 'nope']):
        result = subprocess.run(
            ['bash', str(SCRIPT), '--dry-run', *args], capture_output=True, text=True
        )
        assert result.returncode != 0
