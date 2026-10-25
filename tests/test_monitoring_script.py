"""Dry-run commands and generated Monitoring policies are public output contracts."""

import json
import logging
import os
import shlex
import subprocess

import pytest

from pathlib import Path
from backend.cloud_log import event

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'ops/monitoring/setup-monitoring.sh'
PROJECT = 'alert-disaster-field-2026'
SERVICE = 'alert-disaster-field-estimator'


@pytest.fixture
def preview(tmp_path):
    fake = tmp_path / 'bin'
    fake.mkdir()
    recording = tmp_path / 'calls'
    stub = fake / 'gcloud'
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> "$GCLOUD_RECORDING"\nexit 1\n')
    stub.chmod(0o755)
    configs = tmp_path / 'configs'
    result = subprocess.run(
        ['bash', str(SCRIPT), '--email', 'owner@example.com', '--dry-run',
         '--config-dir', str(configs)],
        capture_output=True, text=True,
        env={**os.environ, 'PATH': f'{fake}:' + os.environ['PATH'],
             'GCLOUD_RECORDING': str(recording)},
    )
    assert result.returncode == 0, result.stderr
    assert not recording.exists()
    commands = [shlex.split(line[2:]) for line in result.stdout.splitlines()
                if line.startswith('+ ')]
    policies = {path.stem.removeprefix('policy-'): json.loads(path.read_text())
                for path in configs.glob('policy-*.json')}
    return commands, policies


def test_preview_targets_project_service_and_notification_address(preview):
    commands, policies = preview
    assert len(commands) == 8
    for command in commands:
        assert command[0] == 'gcloud'
        assert [arg for arg in command if arg.startswith('--project=')] == [f'--project={PROJECT}']
    channel, uptime, *creates = commands
    assert channel[1:5] == ['beta', 'monitoring', 'channels', 'create']
    assert '--channel-labels=email_address=owner@example.com' in channel
    assert uptime[1:4] == ['monitoring', 'uptime', 'create']
    for flag in (f'--resource-labels=host={PROJECT}.web.app,project_id={PROJECT}',
                 '--path=/api/health', '--protocol=https', '--status-codes=200',
                 '--period=5', '--regions=usa-iowa,usa-oregon,usa-virginia',
                 '--matcher-content=healthy'):
        assert flag in uptime
    assert set(policies) == {'site-down', 'server-errors', 'vertex-errors',
                             'email-send-failed', 'email-delivery-failed', 'email-volume'}
    assert len(creates) == len(policies)
    for command in creates:
        assert command[1:4] == ['monitoring', 'policies', 'create']
        filename = next(arg.split('=', 1)[1] for arg in command if arg.startswith('--policy-from-file='))
        assert json.loads(Path(filename).read_text()) in policies.values()
    for policy in policies.values():
        assert policy['combiner'] == 'OR'
        assert policy['notificationChannels'] == [f'projects/{PROJECT}/notificationChannels/NEW_EMAIL_CHANNEL']
        assert policy['alertStrategy']['autoClose'] == '86400s'
    outage = policies['site-down']['conditions'][0]['conditionThreshold']
    assert outage['thresholdValue'] == 1
    assert outage['duration'] == '60s'
    assert outage['aggregations'][0]['crossSeriesReducer'] == 'REDUCE_COUNT_FALSE'
    errors = policies['server-errors']['conditions'][0]['conditionThreshold']
    assert errors['thresholdValue'] == 5
    assert errors['aggregations'][0]['alignmentPeriod'] == '600s'
    assert f'resource.label.service_name="{SERVICE}"' in errors['filter']
    assert 'metric.label.response_code_class="5xx"' in errors['filter']


def matches(filter_text, entry):
    fields = {'resource.type': 'cloud_run_revision',
              'resource.labels.service_name': SERVICE,
              **{f'jsonPayload.{key}': value for key, value in entry.items()}}
    for clause in filter_text.split(' AND '):
        if clause == 'severity>=ERROR':
            if entry['severity'] not in ('ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'):
                return False
        else:
            key, value = clause.split('=', 1)
            if fields.get(key) != json.loads(value):
                return False
    return True


@pytest.mark.parametrize('key,message,fields', [
    ('vertex-errors', 'Vertex AI call', {'operation': 'audit'}),
    ('email-send-failed', 'Email send failed', {'operation': 'email', 'status': 'send_failed'}),
    ('email-delivery-failed', 'Delivery entry', {'operation': 'delivery', 'status': 'failed'}),
    ('email-volume', 'Daily email count', {'operation': 'email', 'status': 'daily_warning'}),
])
def test_log_policy_matches_structured_events(preview, capsys, key, message, fields):
    policy = preview[1][key]
    event(message, logging.ERROR, **fields)
    entry = json.loads(capsys.readouterr().out)
    condition = policy['conditions'][0]['conditionMatchedLog']['filter']
    assert matches(condition, entry)
    assert not matches(condition, {**entry, 'message': 'Unrelated', 'operation': 'unrelated'})
    assert policy['alertStrategy']['notificationRateLimit']['period'] == '3600s'


@pytest.mark.parametrize('args', [[], ['--email', 'nope']])
def test_script_rejects_missing_or_invalid_email(args):
    result = subprocess.run(['bash', str(SCRIPT), '--dry-run', *args], capture_output=True, text=True)
    assert result.returncode != 0
