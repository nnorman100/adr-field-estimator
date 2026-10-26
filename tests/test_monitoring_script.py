"""Dry-run commands and generated Monitoring policies are public output contracts."""

import json
import logging
import os
import re
import shlex
import subprocess

import pytest

from pathlib import Path
from backend.cloud_log import event
from tests.test_backend import context
from tests.test_scope import change, prepared, provider, suggest

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
        env={
            **os.environ,
            'PATH': f'{fake}:' + os.environ['PATH'],
            'GCLOUD_RECORDING': str(recording),
        },
    )
    assert result.returncode == 0, result.stderr
    assert not recording.exists()
    commands = [
        shlex.split(line[2:]) for line in result.stdout.splitlines() if line.startswith('+ ')
    ]
    policies = {
        path.stem.removeprefix('policy-'): json.loads(path.read_text())
        for path in configs.glob('policy-*.json')
    }
    return commands, policies


def test_preview_targets_project_service_and_notification_address(preview):
    commands, policies = preview
    assert len(commands) == 12
    for command in commands:
        assert command[0] == 'gcloud'
        assert [arg for arg in command if arg.startswith('--project=')] == [f'--project={PROJECT}']
    channel, uptime, *creates = commands
    assert channel[1:5] == ['beta', 'monitoring', 'channels', 'create']
    assert '--channel-labels=email_address=owner@example.com' in channel
    assert uptime[1:4] == ['monitoring', 'uptime', 'create']
    for flag in (
        f'--resource-labels=host={PROJECT}.web.app,project_id={PROJECT}',
        '--path=/api/health',
        '--protocol=https',
        '--status-codes=200',
        '--period=5',
        '--regions=usa-iowa,usa-oregon,usa-virginia',
        '--matcher-content=healthy',
    ):
        assert flag in uptime
    assert set(policies) == {
        'site-down',
        'server-errors',
        'vertex-errors',
        'live-provider-errors',
        'email-send-failed',
        'email-delivery-failed',
        'drying-reminder-failed',
        'drying-summary-failed',
        'email-volume',
        'vault-backup',
    }
    assert len(creates) == len(policies)
    for command in creates:
        assert command[1:4] == ['monitoring', 'policies', 'create']
        filename = next(
            arg.split('=', 1)[1] for arg in command if arg.startswith('--policy-from-file=')
        )
        assert json.loads(Path(filename).read_text()) in policies.values()
    for policy in policies.values():
        assert policy['combiner'] == 'OR'
        assert policy['notificationChannels'] == [
            f'projects/{PROJECT}/notificationChannels/NEW_EMAIL_CHANNEL'
        ]
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
    fields = {
        'resource.type': 'cloud_run_revision',
        'resource.labels.service_name': SERVICE,
        **{f'jsonPayload.{key}': value for key, value in entry.items()},
    }
    for clause in filter_text.split(' AND '):
        if clause.startswith('severity>='):
            levels = [
                'DEBUG',
                'INFO',
                'NOTICE',
                'WARNING',
                'ERROR',
                'CRITICAL',
                'ALERT',
                'EMERGENCY',
            ]
            if levels.index(entry['severity']) < levels.index(clause.split('>=', 1)[1]):
                return False
        elif '=~' in clause:
            key, pattern = clause.split('=~', 1)
            if key.startswith('CAST(') and key.endswith(', STRING)'):
                value = fields.get(key[5:-9])
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    value = json.dumps(value)
            else:
                value = fields.get(key)
            if not isinstance(value, str) or not re.search(json.loads(pattern), value):
                return False
        else:
            key, value = clause.split('=', 1)
            if fields.get(key) != json.loads(value):
                return False
    return True


@pytest.mark.parametrize(
    'key,message,fields',
    [
        ('vertex-errors', 'Vertex AI call', {'operation': 'audit'}),
        ('vertex-errors', 'Vertex AI call', {'operation': 'job_summary'}),
        ('vertex-errors', 'Vertex AI call', {'operation': 'job_summary', 'outcome': 'invalid'}),
        ('vertex-errors', 'Vertex AI call', {'operation': 'drying_watch'}),
        (
            'drying-reminder-failed',
            'Drying reminder',
            {'operation': 'reminder', 'status': 'failed'},
        ),
        (
            'drying-summary-failed',
            'Drying summary rejected',
            {'operation': 'drying_watch', 'outcome': 'invalid'},
        ),
        ('email-send-failed', 'Email send failed', {'operation': 'email', 'status': 'send_failed'}),
        ('email-delivery-failed', 'Delivery entry', {'operation': 'delivery', 'status': 'failed'}),
        ('email-volume', 'Daily email count', {'operation': 'email', 'status': 'daily_warning'}),
    ],
)
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
    result = subprocess.run(
        ['bash', str(SCRIPT), '--dry-run', *args], capture_output=True, text=True
    )
    assert result.returncode != 0


@pytest.mark.parametrize('code', [429, 401, 403, 404, 500, 503, 599, 1006, 1011, 1013])
def test_live_provider_failures_match(preview, capsys, code):
    policy = preview[1]['live-provider-errors']
    event(
        'Live session ended',
        logging.WARNING,
        operation='live',
        outcome='ServerError',
        provider_code=code,
    )
    entry = json.loads(capsys.readouterr().out)
    condition = policy['conditions'][0]['conditionMatchedLog']['filter']
    assert matches(condition, entry)
    assert not matches(condition, {**entry, 'operation': 'audit'})
    assert policy['alertStrategy']['notificationRateLimit']['period'] == '3600s'


@pytest.mark.parametrize('outcome', ['finished', 'rollover', 'disconnected', 'closed'])
@pytest.mark.parametrize('code', [None, 1000, 503])
def test_normal_live_endings_do_not_match(preview, capsys, outcome, code):
    event('Live session ended', logging.INFO, operation='live', outcome=outcome, provider_code=code)
    entry = json.loads(capsys.readouterr().out)
    condition = preview[1]['live-provider-errors']['conditions'][0]['conditionMatchedLog']['filter']
    assert not matches(condition, entry)


@pytest.mark.parametrize('code', [None, 1000, 1001, 1008, 499, 600, 1503])
def test_live_other_codes_do_not_match(preview, capsys, code):
    event(
        'Live session ended',
        logging.WARNING,
        operation='live',
        outcome='ConnectionClosed',
        provider_code=code,
    )
    entry = json.loads(capsys.readouterr().out)
    condition = preview[1]['live-provider-errors']['conditions'][0]['conditionMatchedLog']['filter']
    assert not matches(condition, entry)


def test_vault_backup_alert_covers_failure_and_a_missed_day(preview):
    policy = preview[1]['vault-backup']
    assert policy['displayName'] == 'DryScope: vault backup failed or missing'
    assert 'notificationRateLimit' not in policy['alertStrategy']
    failed, absent = policy['conditions']
    threshold = failed['conditionThreshold']
    assert threshold['thresholdValue'] == 0
    assert threshold['duration'] == '0s'
    assert 'resource.type="cloud_run_job"' in threshold['filter']
    assert 'resource.label.job_name="dryscope-vault-backup"' in threshold['filter']
    assert 'metric.label.result="failed"' in threshold['filter']
    assert 'run.googleapis.com/job/completed_execution_count' in threshold['filter']
    missing = absent['conditionAbsent']
    assert missing['duration'] == '82800s'
    assert missing['aggregations'][0]['alignmentPeriod'] == '7200s'
    assert missing['aggregations'][0]['perSeriesAligner'] == 'ALIGN_COUNT'
    assert 'metric.label.result="succeeded"' in missing['filter']
    assert 'dryscope-vault-backup' in missing['filter']


def test_rejected_scope_suggestion_matches_the_vertex_alert(preview, context, monkeypatch, capsys):
    client, _store = context
    prepared(client)
    provider(monkeypatch, [change('air_movers', 99, quote='Invented statement')])
    capsys.readouterr()
    result = suggest(client)
    assert result.status_code == 502, result.text
    assert 'Invented' not in result.text
    entries = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith('{') and 'Vertex AI call' in line
    ]
    assert len(entries) == 1
    entry = entries[0]
    assert entry['severity'] == 'ERROR'
    assert entry['outcome'] == 'validation' and entry['operation'] == 'scope'
    assert 'Invented' not in json.dumps(entry)
    condition = preview[1]['vertex-errors']['conditions'][0]['conditionMatchedLog']['filter']
    assert matches(condition, entry)


@pytest.mark.parametrize('code', [503, 1006])
def test_regex_requires_string_field_or_explicit_cast(capsys, code):
    event('Live session ended', logging.WARNING, operation='live', provider_code=code)
    entry = json.loads(capsys.readouterr().out)
    assert isinstance(entry['provider_code'], int)
    pattern = '"^(5[0-9]{2}|1006|1011|1013)$"'
    assert not matches('jsonPayload.provider_code=~' + pattern, entry)
    assert matches('CAST(jsonPayload.provider_code, STRING)=~' + pattern, entry)
    assert matches('jsonPayload.provider_code=~' + pattern, {'provider_code': json.dumps(code)})
