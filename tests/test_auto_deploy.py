"""Automatic production release: refusals, staging checks, promotion order and rollback.

Everything outside the process is replaced by FakeRunner; no test touches Google Cloud, GitHub or git.
"""

import importlib
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from scripts import auto_deploy as auto
from scripts import deploy_backend

ROOT = Path(__file__).resolve().parents[1]
OLD = 'a' * 40
NEW = 'b' * 40
TAG = 'a' + NEW[:7]
URL = 'https://abbbbbbb---alert-disaster-field-estimator-545776254070.us-west2.run.app'
SERVICE_URL = 'https://alert-disaster-field-estimator-545776254070.us-west2.run.app'
BASELINE = {
    'WORKSPACES_ENABLED': 'true',
    'AI_FEATURES': 'readiness',
    'PRICE_BOOKS_ENABLED': 'false',
    'RETENTION_ENABLED': 'false',
}


def revision(commit, env=None, **overrides):
    env = {
        **BASELINE,
        'INVITATION_TRANSPORT': 'smtp',
        'STAFF_EMAILS': 'owner@example.com',
        **(env or {}),
    }
    items = [{'name': key, 'value': value} for key, value in env.items() if value is not None]
    items.append(
        {
            'name': 'MAPS_API_KEY',
            'valueFrom': {'secretKeyRef': {'name': 'dryscope-maps-api-key', 'key': 'latest'}},
        }
    )
    spec = {
        'serviceAccountName': 'adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com',
        'containerConcurrency': 20,
        'timeoutSeconds': 3600,
        'containers': [{'env': items, 'resources': {'limits': {'cpu': '1', 'memory': '1Gi'}}}],
        **overrides,
    }
    return {'metadata': {'labels': {'source-commit': commit}}, 'spec': spec}


def service_with_min(value):
    """A service as gcloud describes it; the service-level minimum is a service annotation."""
    return {'metadata': {'annotations': {} if value is None else {auto.SERVICE_MIN_SCALE: value}}}


class FakeRunner:
    gcloud = 'gcloud'

    def __init__(
        self,
        serving_commit=OLD,
        changed=('backend/main.py',),
        ancestors=((OLD, NEW), (NEW, 'master'), (OLD, 'master')),
        fail=(),
        staged_env=None,
        refused_status=401,
        health_commit=NEW,
        traffic=None,
        tags=None,
        releases=None,
        log_output='feat: add version numbers (#185)',
        migrations=None,
        serving_version='unknown',
        health_version=None,
        ledger=None,
        branch='master',
        serving_min='1',
        staged_min='1',
    ):
        self.calls = []
        self.service_min = serving_min
        self.staged_min = staged_min
        self.sleeps = []
        self.changed = list(changed)
        self.ancestors = set(ancestors)
        self.fail = set(fail)
        self.refused_status = refused_status
        self.health_commit = health_commit
        self.health_version = health_version
        self.staged_version = None
        self.serving = (serving_commit, serving_version)
        self.live = self.serving
        self.ledger = ledger
        self.branch = branch
        self.traffic = traffic or [{'revisionName': 'rev-old', 'percent': 100}]
        self.revisions = {
            'rev-old': revision(serving_commit),
            'rev-new': revision(NEW, staged_env),
        }
        self.hosting = {'release': '100', 'version': 'v-old'}
        self.tags = dict(tags or {})
        self.remote_tags = dict(tags or {})
        self.releases = dict(releases or {})
        self.log_output = log_output
        self.migrations = list(migrations or [])
        self.head = NEW
        self.sleep = self.sleeps.append

    def keys(self):
        return [call[0] for call in self.calls]

    def completed(self, argv, code=0, out=''):
        return subprocess.CompletedProcess(argv, code, stdout=out, stderr='')

    def run(self, argv, capture=True, check=True):
        result = self.dispatch(argv)
        self.calls.append((self.label(argv), argv))
        if check and result.returncode:
            raise auto.Refused(f'{argv[:3]} failed with exit {result.returncode}')
        return result

    def label(self, argv):
        text = ' '.join(argv)
        for needle, label in (
            ('deploy_backend.py', 'stage'),
            ('ensure_firestore_ttls.py', 'ttl'),
            ('stamp_hosting.py --reset', 'unstamp'),
            ('stamp_hosting.py', 'stamp'),
            ('hosting:clone', 'hosting-clone'),
            ('--only hosting:alert-disaster', 'hosting-deploy'),
            ('verify_hosting.js', 'verify'),
            ('update-traffic', 'traffic'),
        ):
            if needle in text:
                return label
        return argv[0] if argv[0] == 'git' else 'other'

    def dispatch(self, argv):
        text = ' '.join(argv)
        if argv[0] == 'git':
            return self.git(argv)
        if 'describe' in argv and 'services' in argv:
            return self.completed(argv, out=json.dumps(self.service()))
        if 'describe' in argv and 'revisions' in argv:
            return self.completed(
                argv, out=json.dumps(self.revisions[argv[argv.index('describe') + 1]])
            )
        if 'update-traffic' in argv:
            return self.update_traffic(argv)
        if 'print-access-token' in argv:
            return self.completed(argv, out='token\n')
        for needle, name in (
            ('deploy_backend.py', 'stage'),
            ('ensure_firestore_ttls.py', 'ttl'),
            ('verify_hosting.js', 'verify'),
        ):
            if needle in text:
                if name == 'stage':
                    tag = argv[argv.index('--tag') + 1]
                    self.staged_version = argv[argv.index('--version') + 1]
                    self.service_min = self.staged_min
                    self.traffic.append(
                        {'revisionName': 'rev-new', 'percent': 0, 'tag': tag, 'url': URL}
                    )
                return self.completed(argv, 1 if name in self.fail else 0)
        if 'hosting:clone' in text:
            self.hosting = {
                'release': '102',
                'version': argv[argv.index('hosting:clone') + 1].split('@')[1],
            }
            return self.completed(argv, 1 if 'clone' in self.fail else 0)
        if '--only' in argv and 'deploy' in argv:
            if 'hosting-deploy' not in self.fail:
                self.hosting = {'release': '101', 'version': 'v-new'}
            return self.completed(argv, 1 if 'hosting-deploy' in self.fail else 0)
        if argv[0] == 'gh' and argv[1:3] == ['release', 'view']:
            ver = argv[3]
            return self.completed(argv, 0 if ver in self.releases else 1)
        if argv[0] == 'gh' and argv[1:3] == ['release', 'create']:
            ver = argv[3]
            title = argv[argv.index('--title') + 1]
            notes = argv[argv.index('--notes') + 1]
            self.releases[ver] = {'title': title, 'notes': notes}
            return self.completed(argv, 0)
        return self.completed(argv)

    def git(self, argv):
        if argv[1] == 'rev-parse':
            if '--verify' in argv:
                ref = argv[-1]
                tag = ref.removeprefix('refs/tags/').removesuffix('^{commit}')
                commit = self.tags.get(tag, '')
                return self.completed(
                    argv, 0 if commit else 1, out=(commit + '\n') if commit else ''
                )
            return self.completed(argv, out=self.head + '\n')
        if argv[1] == 'fetch':
            return self.completed(argv, 1 if 'fetch' in self.fail else 0)
        if argv[1] == 'symbolic-ref':
            return self.completed(argv, 0 if self.branch else 1, out=(self.branch or '') + '\n')
        if argv[1] == 'describe':
            return self.completed(argv, 1)
        if argv[1] == 'tag':
            if argv[2] == '--points-at':
                target = argv[3]
                found = [t for t, c in self.tags.items() if c == target]
                return self.completed(argv, 0, out='\n'.join(found) + ('\n' if found else ''))
            if argv[2] == '--list':
                prefix = argv[3].removesuffix('*')
                found = [t for t in self.tags if t.startswith(prefix)]
                return self.completed(argv, 0, out='\n'.join(found) + ('\n' if found else ''))
            tag_name, commit = argv[2], argv[3]
            self.tags[tag_name] = commit
            return self.completed(argv, 0)
        if argv[1] == 'ls-remote':
            if 'ls-remote' in self.fail:
                return self.completed(argv, 1)
            ref = argv[-1].removeprefix('refs/tags/')
            commit = self.remote_tags.get(ref, '')
            return self.completed(argv, 0, out=(f'{commit}\trefs/tags/{ref}\n' if commit else ''))
        if argv[1] == 'push':
            ref = argv[-1].removeprefix('refs/tags/')
            self.remote_tags[ref] = self.tags.get(ref, '')
            return self.completed(argv, 0)
        if argv[1] == 'log':
            return self.completed(argv, 0, out=self.log_output)
        if argv[1] == 'show':
            return self.completed(argv, 0, out='2026-11-02\n')
        if argv[1] == 'checkout':
            if '--detach' not in argv:
                self.head = NEW if argv[-1] == self.branch else argv[-1]
                return self.completed(argv, 0)
            self.head = argv[-1]
            self.health_commit = self.head
            self.revisions['rev-new'] = revision(self.head)
            return self.completed(argv, 0)
        if argv[1] == 'merge-base':
            first, second = argv[-2], argv[-1]
            second = 'master' if second == 'origin/master' else second
            return self.completed(argv, 0 if (first, second) in self.ancestors else 1)
        if argv[1] == 'cat-file':
            return self.completed(argv)
        if argv[1] == 'diff':
            return self.completed(argv, out='\n'.join(self.changed))
        raise AssertionError(argv)

    def service(self):
        return {
            **service_with_min(self.service_min),
            'status': {'url': SERVICE_URL, 'traffic': self.traffic},
        }

    def update_traffic(self, argv):
        flag = next(item for item in argv if item.startswith(('--to-tags=', '--to-revisions=')))
        target = flag.split('=', 1)[1].rsplit('=', 1)[0]
        name = target if flag.startswith('--to-revisions') else 'rev-new'
        self.live = (
            self.serving
            if flag.startswith('--to-revisions')
            else (self.health_commit, self.health_version or self.staged_version)
        )
        self.traffic = [
            {**entry, 'percent': 100 if entry['revisionName'] == name else 0}
            for entry in self.traffic
            if entry.get('tag') or entry['revisionName'] == name
        ]
        if not any(entry['revisionName'] == name for entry in self.traffic):
            self.traffic.append({'revisionName': name, 'percent': 100})
        return self.completed(argv)

    def fetch(self, url, method='GET', body=None, headers=None, timeout=30):
        if url.endswith('/api/health'):
            commit, version = (
                self.live
                if url.startswith(SERVICE_URL)
                else (self.health_commit, self.health_version or self.staged_version)
            )
            payload = {
                'status': 'healthy',
                'schema_version': 3,
                'version': version,
                'source_commit': commit,
            }
            return 200, json.dumps(payload)
        if 'documents/_migrations' in url:
            return self.ledger or (200, json.dumps({'documents': self.migrations}))
        if 'firebasehosting.googleapis.com' in url:
            return 200, json.dumps(
                {
                    'releases': [
                        {
                            'name': f'sites/x/channels/live/releases/{self.hosting["release"]}',
                            'version': {'name': f'sites/x/versions/{self.hosting["version"]}'},
                        }
                    ]
                }
            )
        return self.refused_status, '{}'


class Summary:
    def __init__(self, tmp_path, monkeypatch):
        self.path = tmp_path / 'summary.md'
        monkeypatch.setenv('GITHUB_STEP_SUMMARY', str(self.path))

    def text(self):
        return self.path.read_text(encoding='utf8')


@pytest.fixture
def summary(tmp_path, monkeypatch):
    return Summary(tmp_path, monkeypatch)


def release(runner, *extra):
    return auto.main(['--commit', NEW, *extra], runner=runner)


def test_happy_path_follows_the_manual_order_and_records_the_release(summary):
    runner = FakeRunner()
    assert release(runner) == 0
    order = [key for key in runner.keys() if key not in ('git', 'other')]
    assert order == ['ttl', 'stage', 'traffic', 'stamp', 'hosting-deploy', 'verify', 'unstamp']
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--workspaces') + 1] == 'on'
    assert stage[stage.index('--ai-features') + 1] == 'readiness'
    assert stage[stage.index('--price-books') + 1] == 'off'
    assert stage[stage.index('--tag') + 1] == TAG and '--yes' in stage
    text = summary.text()
    for fact in (NEW, 'rev-new', TAG, 'rev-old', 'v-old', 'v-new', '`101`', 'released'):
        assert fact in text
    assert runner.traffic[-1] == {'revisionName': 'rev-new', 'percent': 100} or any(
        entry['revisionName'] == 'rev-new' and entry['percent'] == 100 for entry in runner.traffic
    )


def test_only_the_dedicated_hosting_target_is_ever_deployed():
    runner = FakeRunner()
    release(runner)
    deploys = [argv for key, argv in runner.calls if argv and 'deploy' in argv and argv[0] == 'npx']
    assert len(deploys) == 1
    argv = deploys[0]
    assert argv[argv.index('--only') + 1] == 'hosting:alert-disaster'
    assert '--project=alert-disaster-field-2026' in argv
    assert not any('firestore' in ' '.join(argv) for key, argv in runner.calls if argv[0] == 'npx')


@pytest.mark.parametrize('name', ['firestore.rules', 'firestore.indexes.json'])
def test_rules_or_indexes_change_stops_before_anything_is_staged(summary, name):
    runner = FakeRunner(changed=['backend/main.py', name])
    assert release(runner) == 1
    assert 'stage' not in runner.keys() and 'traffic' not in runner.keys()
    assert name in summary.text() and 'by hand' in summary.text()


def test_other_file_changes_do_not_block():
    assert release(FakeRunner(changed=['firestore.rules.md', 'docs/firestore.indexes.json'])) == 0


def test_same_commit_is_skipped_without_error(summary):
    runner = FakeRunner(serving_commit=NEW)
    assert release(runner) == 0
    assert 'stage' not in runner.keys()
    assert 'already serving' in summary.text()


def test_older_commit_never_moves_production_backwards(summary):
    runner = FakeRunner(ancestors=((NEW, OLD), (NEW, 'master')))
    assert release(runner) == 0
    assert 'stage' not in runner.keys()
    assert 'older than the serving' in summary.text()


def test_serving_commit_that_is_not_an_ancestor_is_refused(summary):
    runner = FakeRunner(ancestors=((NEW, 'master'),))
    assert release(runner) == 1
    assert 'stage' not in runner.keys()


def test_commit_not_on_master_is_refused():
    runner = FakeRunner(ancestors=((OLD, NEW),))
    assert release(runner) == 1
    assert 'stage' not in runner.keys()


@pytest.mark.parametrize('label', ['', 'unknown', OLD + '-dirty'])
def test_serving_revision_without_a_clean_commit_is_refused(label):
    runner = FakeRunner(serving_commit=label)
    assert release(runner) == 1
    assert 'stage' not in runner.keys()


def test_split_traffic_is_refused_because_the_rollback_target_is_ambiguous():
    runner = FakeRunner(
        traffic=[
            {'revisionName': 'rev-old', 'percent': 90},
            {'revisionName': 'rev-older', 'percent': 10},
        ]
    )
    assert release(runner) == 1
    assert 'stage' not in runner.keys()


def test_missing_ttl_policy_stops_before_staging():
    runner = FakeRunner(fail={'ttl'})
    assert release(runner) == 1
    assert 'stage' not in runner.keys()


def test_check_only_stages_and_deploys_nothing(summary):
    runner = FakeRunner()
    assert release(runner, '--check-only') == 0
    assert set(runner.keys()) <= {'git', 'ttl', 'other'}
    assert 'nothing deployed' in summary.text()


def test_stage_carries_the_serving_staff_emails_explicitly(summary):
    runner = FakeRunner(staged_env={'STAFF_EMAILS': 'owner@example.com'})
    runner.revisions['rev-old'] = revision(OLD, {'STAFF_EMAILS': 'owner@example.com'})
    assert release(runner) == 0
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--staff-emails') + 1] == 'owner@example.com'


@pytest.mark.parametrize('serving_value', [None, '', ' , '])
def test_release_is_refused_before_staging_when_the_serving_revision_has_no_staff_emails(
    summary, serving_value
):
    runner = FakeRunner()
    runner.revisions['rev-old'] = revision(OLD, {'STAFF_EMAILS': serving_value})
    assert release(runner) == 1
    assert not {'stage', 'traffic', 'stamp', 'hosting-deploy'} & set(runner.keys())
    assert runner.traffic[0]['revisionName'] == 'rev-old' and runner.traffic[0]['percent'] == 100
    assert 'no usable STAFF_EMAILS' in summary.text()


def test_check_only_also_refuses_when_the_serving_revision_has_no_staff_emails(summary):
    runner = FakeRunner()
    runner.revisions['rev-old'] = revision(OLD, {'STAFF_EMAILS': None})
    assert release(runner, '--check-only') == 1
    assert 'STAFF_EMAILS' in summary.text()


def test_serving_staff_emails_are_normalized_before_staging_and_comparing(summary):
    runner = FakeRunner(staged_env={'STAFF_EMAILS': 'owner@example.com,staff@example.com'})
    runner.revisions['rev-old'] = revision(
        OLD, {'STAFF_EMAILS': ' Owner@Example.com, staff@example.com,,owner@example.com'}
    )
    assert release(runner) == 0
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--staff-emails') + 1] == 'owner@example.com,staff@example.com'
    assert 'traffic' in runner.keys()


def test_a_staged_staff_list_that_differs_from_serving_is_refused(summary):
    runner = FakeRunner(staged_env={'STAFF_EMAILS': 'other@example.com'})
    runner.revisions['rev-old'] = revision(OLD, {'STAFF_EMAILS': 'owner@example.com'})
    assert release(runner) == 1
    assert 'traffic' not in runner.keys()


@pytest.mark.parametrize(
    'kwargs',
    [
        {'health_commit': OLD},
        {'health_version': 'unknown'},
        {'refused_status': 200},
        {'refused_status': 500},
        {'staged_env': {'INVITATION_TRANSPORT': None}},
        {'staged_env': {'INVITATION_TRANSPORT': 'log'}},
        {'staged_env': {'STAFF_EMAILS': 'x@example.com'}},
        {'staged_env': {'WORKSPACES_ENABLED': 'false'}},
    ],
)
def test_failed_check_before_promotion_promotes_nothing(summary, kwargs):
    runner = FakeRunner(**kwargs)
    assert release(runner) == 1
    assert 'stage' in runner.keys()
    assert 'traffic' not in runner.keys()
    assert 'stamp' not in runner.keys() and 'hosting-deploy' not in runner.keys()
    assert runner.traffic[0]['revisionName'] == 'rev-old' and runner.traffic[0]['percent'] == 100


def test_health_is_retried_for_a_cold_start():
    runner = FakeRunner()
    answers = iter([(503, 'cold'), (503, 'cold')])
    original = runner.fetch

    def fetch(url, **kwargs):
        if url.endswith('/api/health'):
            answer = next(answers, None)
            if answer:
                return answer
        return original(url, **kwargs)

    runner.fetch = fetch
    assert release(runner) == 0
    assert runner.sleeps == [10, 10]


def test_a_baseline_that_is_not_less_permissive_is_recorded_not_blocked(summary, todays_baseline):
    # Unset is off on the server, so the repository baseline only adds to what is serving.
    runner = FakeRunner()
    runner.revisions['rev-old'] = revision(OLD, {'AI_FEATURES': None, 'PRICE_BOOKS_ENABLED': None})
    assert release(runner) == 0
    assert "AI_FEATURES '(unset)' -> 'readiness'" in summary.text()
    assert "PRICE_BOOKS_ENABLED '(unset)' -> 'false'" in summary.text()


def confirmations(expression):
    """The flag each dispatch input turns on in a workflow expression."""
    return dict(re.findall(r"inputs\.(\w+) == 'yes' && '(--[\w-]+)'", expression))


def serving_with(runner, commit=OLD, **env):
    runner.revisions['rev-old'] = revision(commit, env)
    return runner


def stage_values(runner):
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    return stage[stage.index('--ai-features') + 1], stage[stage.index('--price-books') + 1]


@pytest.fixture
def todays_baseline(monkeypatch):
    """These tests are about the comparison, so they survive a later change of the constants."""
    monkeypatch.setattr(auto, 'AI_FEATURES', 'readiness')
    monkeypatch.setattr(auto, 'PRICE_BOOKS', 'off')
    monkeypatch.setitem(BASELINE, 'AI_FEATURES', 'readiness')
    monkeypatch.setitem(BASELINE, 'PRICE_BOOKS_ENABLED', 'false')


def test_price_books_on_serving_refuses_a_baseline_that_would_turn_them_off(
    summary, capsys, todays_baseline
):
    runner = serving_with(FakeRunner(), PRICE_BOOKS_ENABLED='true')
    assert release(runner) == 1
    assert 'stage' not in runner.keys() and 'traffic' not in runner.keys()
    assert 'hosting-deploy' not in runner.keys()
    error = capsys.readouterr().err
    assert '::error::' in error and 'PRICE_BOOKS_ENABLED' in error
    text = summary.text()
    assert "serving 'true', repository baseline 'false'" in text
    assert 'Nothing was staged' in text
    assert 'DEFAULT_PRICE_BOOKS' in text and '--confirm-baseline' in text


def test_a_merge_cannot_undo_price_books_once_the_repository_baseline_is_on(
    summary, monkeypatch, todays_baseline
):
    # The turn-on: the constant changes in a reviewed PR, so this and every later merge stages it.
    monkeypatch.setattr(auto, 'PRICE_BOOKS', 'on')
    runner = FakeRunner(staged_env={'PRICE_BOOKS_ENABLED': 'true'})
    assert release(runner) == 0
    assert stage_values(runner)[1] == 'on'
    assert "PRICE_BOOKS_ENABLED 'false' -> 'true'" in summary.text()

    later = serving_with(
        FakeRunner(staged_env={'PRICE_BOOKS_ENABLED': 'true'}), PRICE_BOOKS_ENABLED='true'
    )
    assert release(later) == 0
    assert stage_values(later)[1] == 'on'


def test_retention_on_serving_refuses_a_baseline_that_would_turn_it_off(
    summary, capsys, monkeypatch, todays_baseline
):
    monkeypatch.setattr(auto, 'RETENTION', 'off')
    runner = serving_with(FakeRunner(), RETENTION_ENABLED='true')
    assert release(runner) == 1
    assert 'stage' not in runner.keys() and 'traffic' not in runner.keys()
    assert 'RETENTION_ENABLED' in capsys.readouterr().err
    text = summary.text()
    assert "RETENTION_ENABLED: serving 'true', repository baseline 'false'" in text
    assert 'DEFAULT_RETENTION' in text and 'Nothing was staged' in text


def test_retention_is_staged_from_the_repository_baseline(summary, monkeypatch, todays_baseline):
    runner = FakeRunner()
    assert release(runner) == 0
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--retention') + 1] == auto.RETENTION == 'off'
    # The turn-on is the constant, changed in a reviewed pull request; every later merge keeps it.
    monkeypatch.setattr(auto, 'RETENTION', 'on')
    later = serving_with(
        FakeRunner(staged_env={'RETENTION_ENABLED': 'true'}), RETENTION_ENABLED='true'
    )
    assert release(later) == 0
    stage = next(argv for key, argv in later.calls if key == 'stage')
    assert stage[stage.index('--retention') + 1] == 'on'


def test_dropping_a_serving_ai_feature_is_refused_and_names_it(summary, todays_baseline):
    runner = serving_with(FakeRunner(), AI_FEATURES='drying_watch,readiness')
    assert release(runner) == 1
    assert 'stage' not in runner.keys()
    text = summary.text()
    assert "AI_FEATURES: serving 'drying_watch,readiness', repository baseline 'readiness'" in text
    assert 'turn off drying_watch' in text and 'DEFAULT_AI_FEATURES' in text


def test_ai_features_are_compared_as_the_server_reads_them(summary, monkeypatch, todays_baseline):
    # Order, case, blanks and repeats do not change what the server enables.
    monkeypatch.setattr(auto, 'AI_FEATURES', 'drying_watch,readiness')
    runner = serving_with(
        FakeRunner(staged_env={'AI_FEATURES': 'drying_watch,readiness'}),
        AI_FEATURES=' Readiness, ,DRYING_WATCH,readiness',
    )
    assert release(runner) == 0


def test_price_books_are_compared_as_the_server_reads_them(summary, todays_baseline):
    # The server enables price books only for the word true, in any case.
    for value in ('TRUE', 'True'):
        assert release(serving_with(FakeRunner(), PRICE_BOOKS_ENABLED=value)) == 1
    for value in ('false', '1', 'yes', '', None):
        assert release(serving_with(FakeRunner(), PRICE_BOOKS_ENABLED=value)) == 0


def test_every_setting_that_would_drop_is_named_in_one_refusal(summary, todays_baseline):
    runner = serving_with(
        FakeRunner(), PRICE_BOOKS_ENABLED='true', AI_FEATURES='job_summary,readiness'
    )
    assert release(runner) == 1
    assert 'PRICE_BOOKS_ENABLED' in summary.text() and 'turn off job_summary' in summary.text()


def test_check_only_also_refuses_a_less_permissive_baseline(summary, todays_baseline):
    runner = serving_with(FakeRunner(), PRICE_BOOKS_ENABLED='true')
    assert release(runner, '--check-only') == 1
    assert 'stage' not in runner.keys()
    assert 'refused or failed' in summary.text()


def test_a_commit_already_serving_is_still_skipped_not_refused(summary, todays_baseline):
    runner = serving_with(FakeRunner(serving_commit=NEW), NEW, PRICE_BOOKS_ENABLED='true')
    assert release(runner) == 0
    assert 'skipped' in summary.text()


def test_a_confirmed_hand_run_lowers_the_baseline_and_says_so(summary, capsys, todays_baseline):
    runner = serving_with(FakeRunner(), PRICE_BOOKS_ENABLED='true')
    assert release(runner, '--confirm-baseline') == 0
    assert stage_values(runner)[1] == 'off'
    assert 'traffic' in runner.keys()
    text = summary.text()
    assert 'Lowered on purpose with --confirm-baseline' in text
    assert "PRICE_BOOKS_ENABLED 'true' -> 'false'" in text
    assert '::warning::' in capsys.readouterr().err


def test_automatic_rollback_after_a_confirmed_release_restores_the_serving_revision(
    summary, todays_baseline
):
    # Traffic returns to the revision that was serving, flag and all; nothing is staged again.
    runner = serving_with(FakeRunner(fail={'verify'}), PRICE_BOOKS_ENABLED='true')
    assert release(runner, '--confirm-baseline') == 1
    assert runner.keys().count('stage') == 1
    rollback = [argv for key, argv in runner.calls if key == 'traffic'][-1]
    assert '--to-revisions=rev-old=100' in rollback
    assert any(
        entry['revisionName'] == 'rev-old' and entry['percent'] == 100 for entry in runner.traffic
    )
    assert 'completed' in summary.text()


def test_the_automatic_workflow_can_never_confirm_a_lower_baseline():
    step = next(step for step in deploy_job()['steps'] if step.get('name') == 'Release')
    variables = {token for token in shlex.split(step['run'], comments=True) if '$' in token}
    assert variables == {'$COMMIT', '$RUN_ID', '$DEPLOY_ARGS'}
    assert confirmations(deploy_job()['env']['DEPLOY_ARGS']) == {}


def test_one_constant_sets_the_baseline_for_both_deploy_scripts(monkeypatch):
    for name, value in (('DEFAULT_PRICE_BOOKS', 'on'), ('DEFAULT_AI_FEATURES', 'job_summary')):
        monkeypatch.setattr(deploy_backend, name, value)
    try:
        importlib.reload(auto)
        assert auto.PRICE_BOOKS == 'on' and auto.AI_FEATURES == 'job_summary'
    finally:
        monkeypatch.undo()
        importlib.reload(auto)
    assert auto.PRICE_BOOKS == deploy_backend.DEFAULT_PRICE_BOOKS


@pytest.mark.parametrize('argv', (['--publish', NEW], ['--next-version']))
def test_confirm_baseline_is_refused_where_nothing_is_staged(argv):
    assert auto.main([*argv, '--confirm-baseline'], runner=FakeRunner()) == 2


def test_failed_verification_rolls_traffic_and_hosting_back_and_fails(summary):
    runner = FakeRunner(fail={'verify'})
    assert release(runner) == 1
    keys = runner.keys()
    assert keys.index('traffic') < keys.index('hosting-deploy') < keys.index('verify')
    rollback = [argv for key, argv in runner.calls if key == 'traffic'][-1]
    assert '--to-revisions=rev-old=100' in rollback
    clone = next(argv for key, argv in runner.calls if key == 'hosting-clone')
    assert 'alert-disaster-field-2026@v-old' in clone
    assert any(
        entry['revisionName'] == 'rev-old' and entry['percent'] == 100 for entry in runner.traffic
    )
    assert runner.hosting['version'] == 'v-old'
    assert 'rolled back' in summary.text() and 'completed' in summary.text()
    assert keys[-1] == 'unstamp'


def test_failed_hosting_deploy_rolls_traffic_back(summary):
    runner = FakeRunner(fail={'hosting-deploy'})
    assert release(runner) == 1
    assert 'verify' not in runner.keys()
    rollback = [argv for key, argv in runner.calls if key == 'traffic'][-1]
    assert '--to-revisions=rev-old=100' in rollback


def test_rollback_failure_is_reported_loudly(summary):
    runner = FakeRunner(fail={'verify', 'clone'})
    assert release(runner) == 1
    assert 'FAILED, restore by hand' in summary.text()


def test_stamp_is_reset_even_when_staging_fails():
    runner = FakeRunner(fail={'verify'})
    release(runner)
    assert runner.keys()[-1] == 'unstamp'


def test_commit_must_be_a_full_hash():
    assert auto.main(['--commit', 'abc'], runner=FakeRunner()) == 2


def test_spec_differences_flag_a_dropped_secret_binding():
    serving = auto.spec_summary(revision(OLD), service_with_min('1'))
    staged_revision = revision(NEW)
    staged_revision['spec']['containers'][0]['env'].pop()
    found = auto.spec_differences(
        serving, auto.spec_summary(staged_revision, service_with_min('1'))
    )
    assert any(item.startswith('MAPS_API_KEY') for item in found)


def test_spec_differences_flag_changed_limits():
    serving = auto.spec_summary(revision(OLD), service_with_min('1'))
    staged = auto.spec_summary(revision(NEW, timeoutSeconds=300), service_with_min('1'))
    assert any(item.startswith('timeoutSeconds') for item in auto.spec_differences(serving, staged))


@pytest.mark.parametrize('staged_min', [None, '0', '2', 'default'])
def test_a_service_without_the_one_instance_minimum_after_staging_promotes_nothing(
    summary, staged_min
):
    runner = FakeRunner(staged_min=staged_min)
    assert release(runner) == 1
    assert 'stage' in runner.keys()
    assert 'traffic' not in runner.keys()
    assert 'stamp' not in runner.keys() and 'hosting-deploy' not in runner.keys()
    assert 'minInstances on the service is' in summary.text()


def test_the_minimum_is_read_from_the_service_not_the_revision(summary):
    runner = FakeRunner(staged_min=None)
    runner.revisions['rev-new']['metadata']['annotations'] = {
        'autoscaling.knative.dev/minScale': '1'
    }
    assert release(runner) == 1
    assert 'traffic' not in runner.keys()


def test_first_warm_release_is_not_refused_but_is_recorded(summary):
    # The service predates the minimum; the release that sets it must not stop.
    runner = FakeRunner(serving_min=None)
    assert release(runner) == 0
    assert 'traffic' in runner.keys()
    assert 'Baseline change: minInstances 0 -> 1' in summary.text()


def test_a_release_that_keeps_the_minimum_records_no_minimum_change(summary):
    assert release(FakeRunner()) == 0
    assert 'minInstances' not in summary.text()


def test_matching_specs_have_no_differences():
    spec = auto.spec_summary(revision(OLD), service_with_min('1'))
    assert (
        auto.spec_differences(spec, auto.spec_summary(revision(NEW), service_with_min('1'))) == []
    )


# --- The workflow and setup script -------------------------------------------------------------

WORKFLOW = (ROOT / '.github' / 'workflows' / 'deploy.yml').read_text(encoding='utf8')
SETUP = (ROOT / 'scripts' / 'setup_auto_deploy.sh').read_text(encoding='utf8')


def test_workflow_runs_only_after_ci_succeeds_on_a_master_push():
    assert re.search(
        r'workflow_run:\s*\n\s*workflows: \[CI\]\s*\n\s*types: \[completed\]', WORKFLOW
    )
    assert 'branches: [master]' in WORKFLOW
    for condition in (
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'master'",
        'github.event.workflow_run.head_repository.full_name == github.repository',
    ):
        assert condition in WORKFLOW
    assert 'pull_request' not in WORKFLOW


def test_workflow_serializes_deploys_and_never_cancels_one_in_flight():
    assert re.search(
        r'concurrency:\s*\n\s*group: production-deploy\s*\n\s*cancel-in-progress: false', WORKFLOW
    )


def test_workflow_uses_keyless_auth_and_never_a_blanket_firebase_deploy():
    assert 'workload_identity_provider: ${{ vars.' in WORKFLOW
    assert 'id-token: write' in WORKFLOW
    assert 'credentials_json' not in WORKFLOW and 'secrets.' not in WORKFLOW
    assert 'firebase deploy' not in WORKFLOW
    assert 'firebase-tools' not in WORKFLOW or '--only' in WORKFLOW


def test_workflow_deploys_the_tested_commit_not_the_branch_tip():
    assert 'ref: ${{ github.event.workflow_run.head_sha || github.sha }}' in WORKFLOW
    assert 'fetch-depth: 0' in WORKFLOW
    assert 'scripts/auto_deploy.py --commit' in WORKFLOW


def test_workflow_actions_are_pinned_to_commits():
    for line in WORKFLOW.splitlines():
        match = re.search(r'uses: (\S+)', line)
        if match:
            assert re.search(r'@[0-9a-f]{40}$', match.group(1)), line


def test_setup_script_restricts_the_identity_to_this_repository_and_master():
    assert 'REPO=nnorman100/adr-field-estimator' in SETUP
    assert "assertion.repository == '$REPO'" in SETUP
    assert "assertion.ref == 'refs/heads/master'" in SETUP
    assert 'roles/owner' not in SETUP and 'roles/editor' not in SETUP
    assert 'keys create' not in SETUP


def test_setup_script_has_valid_shell_syntax():
    subprocess.run(['bash', '-n', str(ROOT / 'scripts' / 'setup_auto_deploy.sh')], check=True)


def test_default_tag_fits_cloud_run_limit_for_real_run_ids():
    tag = auto.default_tag('90d08b55f32e' + '0' * 28, '41140166919')
    assert tag == 'a90d08b5-0166919'
    assert len(tag) + len(auto.SERVICE) <= 46
    assert re.fullmatch(r'[a-z][a-z0-9-]*', tag)
    assert auto.default_tag(NEW, '41140166919') != auto.default_tag(NEW, '41140166920')


def test_check_tag_refuses_the_tag_that_failed_in_production():
    with pytest.raises(auto.Refused):
        auto.check_tag('auto-90d08b55f32e-41140166919')
    with pytest.raises(auto.Refused):
        auto.check_tag('1abc')
    with pytest.raises(auto.Refused):
        auto.check_tag('a' * 17)
    assert auto.check_tag('a' * 16)


def test_overlong_explicit_tag_is_refused_before_anything_runs():
    runner = FakeRunner()
    assert (
        auto.main(['--commit', NEW, '--tag', 'auto-' + NEW[:12] + '-41140166919'], runner=runner)
        == 2
    )


def deploy_job():
    return yaml.safe_load(WORKFLOW)['jobs']['deploy']


def step_argv(name, env):
    step = next(step for step in deploy_job()['steps'] if step.get('name') == name)
    tokens = shlex.split(step['run'], comments=True)
    for key, value in env.items():
        tokens = [token.replace(f'${key}', value) for token in tokens]
    tokens = [token for token in tokens if token]
    return tokens[tokens.index('scripts/auto_deploy.py') + 1 :]


def release_argv(run_id):
    return step_argv('Release', {'COMMIT': NEW, 'RUN_ID': run_id, 'DEPLOY_ARGS': ''})


def test_workflow_release_step_stages_a_tag_cloud_run_accepts():
    argv = release_argv('41140166919')
    assert '--tag' not in argv
    assert argv[argv.index('--run-id') + 1] == '41140166919'
    runner = FakeRunner()
    assert auto.main(argv, runner=runner) == 0
    stage = next(command for key, command in runner.calls if key == 'stage')
    tag = stage[stage.index('--tag') + 1]
    assert auto.check_tag(tag) == tag
    assert tag.endswith('0166919')
