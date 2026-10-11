"""The backend deploy command never inherits the staged workspace flag or moves traffic."""
import pytest
from scripts import deploy_backend as deploy


def test_workspaces_off_is_explicit_and_receives_no_traffic():
    argv = deploy.command('off', 'workspaces-off-1')
    assert '--update-env-vars=WORKSPACES_ENABLED=false' in argv
    assert '--no-traffic' in argv and '--tag=workspaces-off-1' in argv
    for flag in ('--region=us-west2', '--project=alert-disaster-field-2026', '--billing-project=alert-disaster-field-2026',
                 '--service-account=adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com',
                 '--max-instances=2', '--concurrency=20', '--timeout=3600', '--allow-unauthenticated'):
        assert flag in argv
    assert '--update-env-vars=WORKSPACES_ENABLED=true' in deploy.command('on', 'workspaces-on-1')


@pytest.mark.parametrize('argv', [['--tag', 'stage-1', '--yes'], ['--workspaces', 'maybe', '--tag', 'stage-1', '--yes'],
                                  ['--workspaces', 'off', '--yes'], ['--workspaces', 'off', '--tag', 'Bad_Tag', '--yes']])
def test_missing_or_invalid_choice_runs_nothing(argv):
    with pytest.raises(SystemExit):
        deploy.main(argv, run=lambda *args, **kwargs: pytest.fail('gcloud ran'))


def test_dry_run_and_unconfirmed_deploy_run_nothing(capsys):
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--dry-run'], run=never) == 0
    assert 'WORKSPACES_ENABLED=false' in capsys.readouterr().out
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1'], run=never) == 2


def test_confirmed_deploy_runs_the_built_command():
    calls = []
    deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=lambda argv, **kwargs: calls.append(argv) or type('R', (), {'returncode': 0}))
    assert calls[0][1:] == deploy.command('off', 'stage-1')[1:]
