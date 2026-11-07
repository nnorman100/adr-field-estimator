"""Version publication and rollback coverage for automatic releases."""

import itertools
import json

import pytest
import yaml

from scripts import auto_deploy as auto
from tests.github_workflow import condition, interpolate, run_step
from tests.test_auto_deploy import (
    GITHUB_TOKEN,
    NEW,
    OLD,
    WORKFLOW,
    FakeRunner,
    deploy_job,
    deploy_step,
    release,
    serving_with,
    stage_values,
    step_argv,
    summary,
    todays_baseline,
    workflow_context,
)


def ledger_doc(migration_id, commit, applied_at='2026-11-01T10:00:00.123456Z'):
    return {
        'name': f'projects/p/databases/(default)/documents/_migrations/{migration_id}',
        'fields': {
            'migration_id': {'stringValue': migration_id},
            'applied_at': {'timestampValue': applied_at},
            'source_commit': {'stringValue': commit},
        },
    }


def rollback_runner(**kwargs):
    return FakeRunner(
        serving_commit=NEW,
        ancestors={(OLD, NEW), (OLD, OLD), (NEW, 'master'), (OLD, 'master')},
        tags={'2026.10.30-1': OLD, '2026.11.02-1': NEW},
        **kwargs,
    )


def test_version_numbering_counts_up_per_utc_day_and_publishes_github_release(summary):
    runner = FakeRunner()
    assert auto.next_version(runner, NEW, today='2026.11.02') == '2026.11.02-1'
    runner.tags['2026.11.02-1'] = OLD
    runner.tags['2026.11.02-2'] = 'c' * 40
    assert auto.next_version(runner, NEW, today='2026.11.02') == '2026.11.02-3'
    assert release(runner) == 0
    assert not any(c == NEW for c in runner.tags.values())
    assert auto.main(['--publish', NEW], runner=runner) == 0
    created_ver = next(v for v, c in runner.tags.items() if c == NEW)
    assert runner.remote_tags[created_ver] == NEW
    rel = runner.releases[created_ver]
    assert rel['title'] == created_ver
    assert '- Add version numbers (#185)' in rel['notes']
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--version') + 1] == created_ver
    stamp = next(argv for key, argv in runner.calls if key == 'stamp')
    assert stamp[stamp.index('--version') + 1] == created_ver
    assert created_ver in summary.text()


def test_failed_deploy_never_creates_a_version_tag_or_github_release(summary):
    runner = FakeRunner(fail={'verify'})
    assert release(runner) == 1
    assert auto.main(['--publish', NEW], runner=runner) == 0
    assert runner.tags == {} and runner.releases == {}
    assert 'not what is serving' in summary.text()


def test_rerun_on_same_commit_is_idempotent_and_never_moves_existing_tag(summary):
    runner = FakeRunner(
        serving_commit=NEW,
        serving_version='2026.11.02-1',
        tags={'2026.11.02-1': NEW},
        releases={'2026.11.02-1': {'title': '2026.11.02-1', 'notes': 'existing'}},
    )
    assert release(runner) == 0
    assert auto.main(['--publish', NEW], runner=runner) == 0
    assert runner.tags == {'2026.11.02-1': NEW}
    assert not any(argv[:3] == ['gh', 'release', 'create'] for _, argv in runner.calls)
    record = auto.Record()
    with pytest.raises(auto.Refused, match='refusing to move it'):
        auto.publish_release(runner, record, '2026.11.02-1', OLD)


def test_publish_tags_the_version_the_live_backend_reports_not_a_new_number(summary):
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.10.30-4')
    assert auto.main(['--publish', NEW], runner=runner) == 0
    assert runner.tags == {'2026.10.30-4': NEW}
    assert runner.remote_tags == {'2026.10.30-4': NEW}
    assert '2026.10.30-4' in runner.releases


@pytest.mark.parametrize('version', ['unknown', None, '2026.11.02-1-dirty'])
def test_publish_reports_an_unversioned_live_release_and_invents_no_number(
    summary, capsys, version
):
    runner = FakeRunner(serving_commit=NEW, serving_version=version)
    assert auto.main(['--publish', NEW], runner=runner) == 0
    assert runner.tags == {} and runner.releases == {}
    assert '::warning::' in capsys.readouterr().err


def test_publish_refuses_when_the_live_health_cannot_be_read(summary):
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.11.02-1')
    runner.fetch = lambda url, **kwargs: (503, 'down')
    assert auto.main(['--publish', NEW], runner=runner) == 1
    assert runner.tags == {}


def test_publish_refuses_when_the_remote_tag_points_at_another_commit(summary):
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.11.02-1')
    runner.remote_tags['2026.11.02-1'] = OLD
    assert auto.main(['--publish', NEW], runner=runner) == 1
    assert runner.tags == {} and runner.releases == {}
    assert not any(argv[:2] == ['git', 'push'] for _, argv in runner.calls)
    assert 'refusing to move it' in summary.text()


def test_publish_refuses_when_the_remote_tags_cannot_be_read(summary):
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.11.02-1', fail={'ls-remote'})
    assert auto.main(['--publish', NEW], runner=runner) == 1
    assert runner.tags == {} and runner.releases == {}


def test_next_version_prints_the_number_for_a_hand_release(capsys):
    runner = FakeRunner()
    assert auto.main(['--next-version'], runner=runner) == 0
    assert auto.valid_version(capsys.readouterr().out.strip())
    assert ['git', 'fetch', '--tags', '--quiet'] in [argv for _, argv in runner.calls]


def test_next_version_prints_no_number_when_the_tags_cannot_be_fetched(capsys):
    assert auto.main(['--next-version'], runner=FakeRunner(fail={'fetch'})) == 1
    assert capsys.readouterr().out == ''


def test_rollback_past_a_migration_warns_and_stops_before_staging(summary, capsys):
    runner = rollback_runner(
        migrations=[ledger_doc('workspaces', OLD), ledger_doc('price-books-v1', NEW)]
    )
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    err = capsys.readouterr().err
    assert '::warning::Target version 2026.10.30-1' in err
    assert 'price-books-v1 (applied 2026-11-01T10:00:00.123456Z at ' + NEW[:12] in err
    assert 'workspaces' not in err
    assert 'Migration warning' in summary.text()
    assert 'confirm-past-migration' in summary.text()
    assert not {'stage', 'traffic', 'stamp', 'hosting-deploy'} & set(runner.keys())
    assert runner.head == NEW


def test_confirmed_rollback_past_a_migration_redeploys_the_tag(summary, capsys):
    runner = rollback_runner(migrations=[ledger_doc('price-books-v1', NEW)])
    argv = ['--rollback', '2026.10.30-1', '--confirm-past-migration']
    assert auto.main(argv, runner=runner) == 0
    assert '::warning::' in capsys.readouterr().err
    assert 'rolled back to 2026.10.30-1' in summary.text()
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--version') + 1] == '2026.10.30-1'
    assert 'AUTO_DEPLOY_ENABLED' in summary.text() and 'before the next merge' in summary.text()
    assert runner.tags == {'2026.10.30-1': OLD, '2026.11.02-1': NEW}


@pytest.mark.parametrize(
    'argv', [['--rollback', '2026.10.30-1', '--check-only'], ['--publish', NEW, '--check-only']]
)
def test_check_only_is_refused_outside_a_release(argv):
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.11.02-1')
    assert auto.main(argv, runner=runner) == 2
    assert runner.calls == []


@pytest.mark.parametrize('name', ['firestore.rules', 'firestore.indexes.json'])
def test_rollback_across_a_rules_or_index_change_warns_and_stops_unless_confirmed(
    summary, capsys, name
):
    runner = rollback_runner(changed=['backend/main.py', name])
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    err = capsys.readouterr().err
    assert '::warning::' + name in err and 'stay at the newer hand-released version' in err
    assert 'since the serving commit' not in summary.text()
    assert 'confirm-past-migration' in summary.text()
    assert 'stage' not in runner.keys()

    runner = rollback_runner(changed=['backend/main.py', name])
    argv = ['--rollback', '2026.10.30-1', '--confirm-past-migration']
    assert auto.main(argv, runner=runner) == 0
    assert 'stage' in runner.keys()
    assert 'no rules or indexes changed' not in summary.text()


def test_release_notes_list_each_squash_merged_pr_in_plain_words():
    runner = FakeRunner(log_output='feat(backend): add a thing (#7)\nfix: repair a thing (#8)')
    notes = auto.release_notes(runner, NEW)
    assert notes.splitlines()[2:] == ['- Add a thing (#7)', '- Repair a thing (#8)']


def test_rollback_without_newer_migrations_passes_cleanly(summary, capsys):
    runner = rollback_runner(migrations=[ledger_doc('workspaces', OLD)])
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 0
    assert '::warning::' not in capsys.readouterr().err
    assert 'no applied migrations newer than target version' in summary.text()
    assert 'stage' in runner.keys()


@pytest.mark.parametrize(
    'ledger',
    [
        (500, '{}'),
        (403, '{}'),
        (404, '{}'),
        (0, 'timed out'),
        (200, 'not json'),
        (200, json.dumps({'documents': [], 'nextPageToken': 'more'})),
    ],
)
def test_unreadable_ledger_warns_and_stops_instead_of_reporting_a_pass(summary, capsys, ledger):
    runner = rollback_runner(ledger=ledger)
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    assert '::warning::Could not read' in capsys.readouterr().err
    assert 'Migration check passed' not in summary.text()
    assert 'stage' not in runner.keys()


def test_ledger_commit_marked_dirty_is_compared_by_its_commit(summary, capsys):
    runner = rollback_runner(migrations=[ledger_doc('workspaces', OLD + '-dirty')])
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 0
    assert '::warning::' not in capsys.readouterr().err


@pytest.mark.parametrize('commit', ['unknown', 'c' * 40])
def test_ledger_commit_that_is_unknown_or_not_an_ancestor_counts_as_newer(summary, commit):
    runner = rollback_runner(migrations=[ledger_doc('adr-company-v1', commit)])
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    assert 'stage' not in runner.keys()


@pytest.mark.parametrize('fail', [(), ('verify',)])
def test_rollback_returns_the_checkout_to_its_branch(summary, fail):
    runner = rollback_runner(fail=fail)
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == (1 if fail else 0)
    checkouts = [argv for _, argv in runner.calls if argv[:2] == ['git', 'checkout']]
    assert checkouts == [
        ['git', 'checkout', '--detach', OLD],
        ['git', 'checkout', 'master'],
    ]
    assert runner.head == NEW


def test_rollback_from_a_detached_checkout_returns_to_that_commit(summary):
    runner = rollback_runner(branch=None)
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 0
    assert runner.head == NEW


def test_workflow_offers_a_rollback_with_an_explicit_migration_confirmation():
    inputs = yaml.safe_load(WORKFLOW)[True]['workflow_dispatch']['inputs']
    assert set(inputs) == {'version', 'confirm_past_migration', 'confirm_baseline'}
    assert inputs['confirm_baseline']['default'] == 'no'
    assert inputs['confirm_baseline']['options'] == ['no', 'yes']
    assert inputs['version']['required'] is False
    assert inputs['confirm_past_migration']['default'] == 'no'
    assert inputs['confirm_past_migration']['options'] == ['no', 'yes']


def test_workflow_rollback_step_stops_at_a_migration_unless_confirmed(summary):
    env = {'ROLLBACK_VERSION': '2026.10.30-1', 'RUN_ID': '41140166919'}
    plain = step_argv('Roll back to version', {**env, 'CONFIRM_ARGS': ''})
    runner = rollback_runner(migrations=[ledger_doc('price-books-v1', NEW)])
    assert auto.main(plain, runner=runner) == 1
    assert 'stage' not in runner.keys()
    confirmed = step_argv(
        'Roll back to version', {**env, 'CONFIRM_ARGS': '--confirm-past-migration'}
    )
    runner = rollback_runner(migrations=[ledger_doc('price-books-v1', NEW)])
    assert auto.main(confirmed, runner=runner) == 0
    stage = next(argv for key, argv in runner.calls if key == 'stage')
    assert stage[stage.index('--tag') + 1].endswith('0166919')


def test_rollback_with_a_less_permissive_baseline_stops_before_staging(summary, todays_baseline):
    runner = serving_with(rollback_runner(), NEW, PRICE_BOOKS_ENABLED='true')
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    assert 'stage' not in runner.keys() and 'traffic' not in runner.keys()
    assert runner.head == NEW
    text = summary.text()
    assert 'PRICE_BOOKS_ENABLED' in text and 'Nothing was staged' in text
    assert 'confirm_baseline=yes' in text


def test_rollback_names_a_migration_and_a_lower_baseline_in_one_refusal(summary, todays_baseline):
    runner = serving_with(
        rollback_runner(migrations=[ledger_doc('price-books-v1', NEW)]),
        NEW,
        PRICE_BOOKS_ENABLED='true',
    )
    assert auto.main(['--rollback', '2026.10.30-1'], runner=runner) == 1
    text = summary.text()
    assert '--confirm-past-migration' in text and '--confirm-baseline' in text


def test_workflow_rollback_step_restores_an_older_revision_when_the_baseline_is_confirmed(
    summary, todays_baseline
):
    env = {'ROLLBACK_VERSION': '2026.10.30-1', 'RUN_ID': '41140166919'}
    plain = step_argv('Roll back to version', {**env, 'CONFIRM_ARGS': ''})
    runner = serving_with(rollback_runner(), NEW, PRICE_BOOKS_ENABLED='true')
    assert auto.main(plain, runner=runner) == 1
    assert 'stage' not in runner.keys()

    confirmed = step_argv('Roll back to version', {**env, 'CONFIRM_ARGS': '--confirm-baseline'})
    runner = serving_with(rollback_runner(), NEW, PRICE_BOOKS_ENABLED='true')
    assert auto.main(confirmed, runner=runner) == 0
    assert stage_values(runner) == ('readiness', 'off')
    assert 'Rolled production back to version 2026.10.30-1' in summary.text()


def test_workflow_passes_each_rollback_confirmation_from_its_own_input():
    job = deploy_job()
    rollback = deploy_step('Roll back to version')
    flags = {
        'confirm_past_migration': '--confirm-past-migration',
        'confirm_baseline': '--confirm-baseline',
    }
    for past, baseline in itertools.product(['no', 'yes'], repeat=2):
        inputs = {
            'version': '2026.10.30-1',
            'confirm_past_migration': past,
            'confirm_baseline': baseline,
        }
        context = workflow_context('workflow_dispatch', **inputs)
        assert condition(rollback['if'], context)
        env = {name: interpolate(value, context) for name, value in job['env'].items()}
        expected = [flag for name, flag in flags.items() if inputs[name] == 'yes']
        assert step_argv('Roll back to version', env) == [
            '--rollback',
            '2026.10.30-1',
            '--run-id',
            '41140166919',
            *expected,
        ]
    assert not condition(rollback['if'], workflow_context('workflow_run'))


def test_workflow_publish_step_publishes_the_commit_that_was_released(summary):
    argv = step_argv('Publish version', {'COMMIT': NEW})
    runner = FakeRunner(serving_commit=NEW, serving_version='2026.11.02-1')
    assert auto.main(argv, runner=runner) == 0
    assert runner.remote_tags == {'2026.11.02-1': NEW}


def test_only_the_publish_step_receives_a_github_write_token():
    job = deploy_job()
    assert job['permissions'] == {'contents': 'write', 'id-token': 'write'}
    context = workflow_context('workflow_run')
    env = interpolate(job['env'], context)
    assert GITHUB_TOKEN not in env.values()
    checkout = job['steps'][0]
    assert checkout['uses'].startswith('actions/checkout@')
    assert checkout['with']['persist-credentials'] is False
    holders = [
        step for step in job['steps'] if GITHUB_TOKEN in json.dumps(interpolate(step, context))
    ]
    assert [step['name'] for step in holders] == ['Publish version']
    assert interpolate(holders[0]['env'], context) == {'GH_TOKEN': GITHUB_TOKEN}
    assert condition(holders[0]['if'], context)
    assert not condition(holders[0]['if'], workflow_context('workflow_dispatch', version=''))
    commands = run_step(holders[0], {**env, **interpolate(holders[0]['env'], context)})
    assert commands == [
        ['gh', 'auth', 'setup-git'],
        ['python3', 'scripts/auto_deploy.py', '--publish', NEW],
    ]
