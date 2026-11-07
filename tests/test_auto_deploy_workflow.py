"""The Deploy workflow's triggers, permissions and steps, and the one-time setup script."""

import json
import re
import subprocess

import pytest
import yaml

from tests.github_workflow import ROOT, condition, interpolate, run_step, run_stubbed
from tests.test_auto_deploy import NEW, WORKFLOW, deploy_job, step_argv, workflow_context

REPOSITORY = 'nnorman100/adr-field-estimator'
TESTED = 'c' * 40
SETUP = ROOT / 'scripts' / 'setup_auto_deploy.sh'
STEP_TOOLS = ('python3', 'gh', 'pip', 'npm', 'npx', 'firebase', 'gcloud')


class Secrets(dict):
    def get(self, key, default=None):
        return f'secret-{key}'


def ci_run(**changes):
    """The context of a Deploy run started by a completed CI run, by default a good master push."""
    run = {
        'conclusion': 'success',
        'event': 'push',
        'head_branch': 'master',
        'head_sha': TESTED,
        'head_repository': {'full_name': REPOSITORY},
        **changes,
    }
    context = workflow_context('workflow_run')
    context['github'].update(repository=REPOSITORY, event={'workflow_run': run})
    context['vars'] = {'AUTO_DEPLOY_ENABLED': 'true'}
    return context


def dispatch(**inputs):
    context = workflow_context('workflow_dispatch', **{'version': '', **inputs})
    context['github']['repository'] = REPOSITORY
    context['vars'] = {'AUTO_DEPLOY_ENABLED': 'true'}
    return context


def flag(argv, name):
    return next((arg.split('=', 1)[1] for arg in argv if arg.startswith(f'{name}=')), None)


def test_workflow_runs_only_after_ci_succeeds_on_a_master_push():
    workflow = yaml.safe_load(WORKFLOW)
    assert set(workflow[True]) == {'workflow_run', 'workflow_dispatch'}
    assert workflow[True]['workflow_run'] == {
        'workflows': ['CI'],
        'types': ['completed'],
        'branches': ['master'],
    }
    assert set(workflow['jobs']) == {'deploy'}
    gate = deploy_job()['if']
    assert condition(gate, ci_run())
    assert condition(gate, dispatch())
    for change in (
        {'conclusion': 'failure'},
        {'event': 'pull_request'},
        {'head_branch': 'feature'},
        {'head_repository': {'full_name': 'someone/fork'}},
    ):
        assert not condition(gate, ci_run(**change)), change
    paused = ci_run()
    paused['vars']['AUTO_DEPLOY_ENABLED'] = 'false'
    assert not condition(gate, paused)


def test_workflow_serializes_deploys_and_never_cancels_one_in_flight():
    assert deploy_job()['concurrency'] == {
        'group': 'production-deploy',
        'cancel-in-progress': False,
    }


def test_workflow_uses_keyless_auth_and_never_a_blanket_firebase_deploy():
    context = ci_run()
    context['vars'].update(
        GCP_WORKLOAD_IDENTITY_PROVIDER='provider', GCP_DEPLOY_SERVICE_ACCOUNT='deployer'
    )
    context['secrets'] = Secrets()
    assert 'secret-' not in json.dumps(interpolate(yaml.safe_load(WORKFLOW), context))
    job = interpolate(deploy_job(), context)
    assert job['permissions']['id-token'] == 'write'
    auth = [s for s in job['steps'] if s.get('uses', '').startswith('google-github-actions/auth@')]
    assert [step['with'] for step in auth] == [
        {
            'workload_identity_provider': 'provider',
            'service_account': 'deployer',
            'project_id': 'alert-disaster-field-2026',
        }
    ]
    commands = []
    for step in job['steps']:
        if 'run' in step:
            env = {**job['env'], **step.get('env', {}), 'GITHUB_OUTPUT': '/dev/null'}
            commands += run_step(step, env, commands=STEP_TOOLS)
    assert ['npm', 'ci'] in commands
    assert not [argv for argv in commands if argv[0] == 'firebase' and 'deploy' in argv]
    firebase_tools = [a for a in commands if any(arg.startswith('firebase-tools') for arg in a)]
    assert all('--only' in argv for argv in firebase_tools)


def test_workflow_deploys_the_tested_commit_not_the_branch_tip():
    for context, commit in ((ci_run(), TESTED), (dispatch(), NEW)):
        job = interpolate(deploy_job(), context)
        checkout = next(
            step for step in job['steps'] if step.get('uses', '').startswith('actions/checkout@')
        )
        assert checkout['with']['ref'] == commit
        assert checkout['with']['fetch-depth'] == 0
        assert step_argv('Release', job['env'])[:2] == ['--commit', commit]


def test_workflow_actions_are_pinned_to_commits():
    for job in yaml.safe_load(WORKFLOW)['jobs'].values():
        for uses in [job.get('uses')] + [step.get('uses') for step in job.get('steps', [])]:
            if uses is not None:
                assert re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', uses), uses


@pytest.mark.parametrize('fails', [None, 'describe'])
def test_setup_script_restricts_the_identity_to_this_repository_and_master(fails):
    calls = run_stubbed([str(SETUP)], {}, ['gcloud'], passthrough=['cat'], fails=fails)
    oidc = ('create-oidc', 'update-oidc')
    providers = [
        argv
        for argv in calls
        if argv[1:4] == ['iam', 'workload-identity-pools', 'providers'] and argv[4] in oidc
    ]
    assert [argv[4] for argv in providers] == ['create-oidc' if fails else 'update-oidc']
    assert flag(providers[0], '--attribute-condition') == (
        f"assertion.repository == '{REPOSITORY}' && assertion.ref == 'refs/heads/master' && "
        f"assertion.job_workflow_ref.startsWith('{REPOSITORY}/.github/workflows/deploy.yml@')"
    )
    members = [
        flag(argv, '--member')
        for argv in calls
        if flag(argv, '--role') == 'roles/iam.workloadIdentityUser'
    ]
    assert members == [
        'principalSet://iam.googleapis.com/projects/545776254070/locations/global/'
        f'workloadIdentityPools/github-actions/attribute.repository/{REPOSITORY}'
    ]
    roles = {flag(argv, '--role') for argv in calls} - {None}
    assert roles and not roles & {'roles/owner', 'roles/editor'}
    assert not [argv for argv in calls if 'keys' in argv]
    assert run_stubbed([str(SETUP), '--dry-run'], {}, ['gcloud'], passthrough=['cat']) == []


def test_setup_script_has_valid_shell_syntax():
    subprocess.run(['bash', '-n', str(SETUP)], check=True)
