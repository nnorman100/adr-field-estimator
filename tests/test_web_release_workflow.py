"""Guards for the rebuilt app's test release path (.github/workflows/web-release.yml), its image
(web/Dockerfile) and the Live relay placeholder. Each test names a property the release relies on:
keyless sign-in as the right test account, pinned actions and images, no live or legacy target,
staging at 0% before any traffic moves, and rollback only after a move."""

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / '.github' / 'workflows' / 'web-release.yml'
WEB = ROOT / '.github' / 'workflows' / 'web.yml'


def load(path):
    return yaml.safe_load(path.read_text())


def steps(job):
    return job.get('steps', [])


def run_text(job):
    return '\n'.join(step.get('run', '') for step in steps(job))


@pytest.fixture(scope='module')
def release():
    return load(RELEASE)


def test_release_runs_only_after_web_app_passes_on_master(release):
    triggers = release[True]  # PyYAML reads the bare `on` key as True.
    assert set(triggers) == {'workflow_run', 'workflow_dispatch'}
    assert triggers['workflow_run'] == {
        'workflows': ['Web app'],
        'types': ['completed'],
        'branches': ['master'],
    }
    gate = release['jobs']['gate']['if']
    for needed in (
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'master'",
        'github.event.workflow_run.head_repository.full_name == github.repository',
        "github.ref == 'refs/heads/master'",
    ):
        assert needed in gate
    assert release['env']['COMMIT'] == '${{ github.event.workflow_run.head_sha || github.sha }}'


def test_one_release_at_a_time_and_none_cancelled_midway(release):
    assert release['concurrency'] == {'group': 'web-release-test', 'cancel-in-progress': False}


@pytest.mark.parametrize('path', [RELEASE, WEB])
def test_every_action_is_pinned_to_a_full_commit(path):
    uses = re.findall(r'uses:\s*(\S+)', path.read_text())
    assert uses
    for ref in uses:
        assert re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', ref), ref


@pytest.mark.parametrize('path', [RELEASE, WEB])
def test_every_job_has_a_time_limit(path):
    for name, job in load(path)['jobs'].items():
        assert isinstance(job.get('timeout-minutes'), int), name


def test_least_privilege_and_the_test_environment(release):
    assert release['permissions'] == {}
    for name, job in release['jobs'].items():
        perms = job.get('permissions', {})
        assert set(perms.items()) <= {('contents', 'read'), ('id-token', 'write')}, name
        if perms.get('id-token') == 'write':
            assert job['environment'] == 'test', name


def test_each_job_signs_in_keylessly_as_its_own_test_account(release):
    accounts = {}
    for name, job in release['jobs'].items():
        for step in steps(job):
            if step.get('uses', '').startswith('google-github-actions/auth@'):
                given = step['with']
                assert set(given) == {'workload_identity_provider', 'service_account', 'project_id'}
                assert (
                    given['workload_identity_provider'] == '${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}'
                )
                assert given['project_id'] == 'dryscope'
                accounts[name] = given['service_account']
    assert accounts == {
        'build': '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
        'migrate': '${{ vars.DRYSCOPE_TEST_MIGRATE_SA }}',
        'deploy': '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
    }
    text = RELEASE.read_text()
    for key in ('credentials_json', 'GOOGLE_CREDENTIALS', 'private_key'):
        assert key not in text


def test_skips_until_set_up_and_refuses_variables_pointing_anywhere_but_test(release):
    gate = run_text(release['jobs']['gate'])
    assert 'Test release skipped' in gate and 'ready=false' in gate
    assert 'workloadIdentityPools/dryscope-test/providers/' in gate
    assert '"dryscope-deploy-test@dryscope.iam.gserviceaccount.com"' in gate
    assert '"dryscope-migrate-test@dryscope.iam.gserviceaccount.com"' in gate
    build = release['jobs']['build']
    assert build['if'] == "needs.gate.outputs.ready == 'true'"
    assert 'is not visible to the deploy account yet' in run_text(build)
    for name in ('migrate', 'deploy'):
        assert release['jobs'][name]['if'] == "needs.build.outputs.service_ready == 'true'"


def test_targets_only_the_test_environment_and_never_the_legacy_project():
    text = RELEASE.read_text()
    for forbidden in (
        'dryscope-live',
        '-live@',
        'dryscope-live-',
        'alert-disaster',
        'us-west2',
        'firebase',
    ):
        assert forbidden not in text, forbidden
    env = load(RELEASE)['env']
    assert env['SERVICE'] == 'dryscope-api-test'
    assert env['IMAGE'].startswith('us-central1-docker.pkg.dev/dryscope/dryscope-test/')
    assert env['SQL_INSTANCE'] == 'dryscope:us-central1:dryscope-test-pg'


def test_nothing_is_deleted_and_only_the_image_changes(release):
    text = RELEASE.read_text()
    assert not re.search(r'\b(delete|remove-tags|clear-tags)\b', text)
    deploy = run_text(release['jobs']['deploy'])
    (command,) = re.findall(r'gcloud run deploy [^\n]*', deploy)
    assert '--no-traffic' in command and '--tag=candidate' in command
    assert '--image="$IMAGE_REF"' in command
    for flag in (
        '--allow-unauthenticated',
        '--service-account',
        'env-vars',
        '--port',
        '--set-secrets',
        '--update-secrets',
    ):
        assert flag not in command, flag


def test_migrations_run_as_the_migrator_before_the_revision_is_staged(release):
    jobs = release['jobs']
    assert set(jobs['deploy']['needs']) == {'build', 'migrate'}
    migrate = run_text(jobs['migrate'])
    assert 'sha256sum --check --strict' in migrate
    assert '--auto-iam-authn' in migrate
    assert 'npm run db:migrate' in migrate
    url = jobs['migrate']['steps'][-1]['env']['DATABASE_URL']
    assert url == 'postgres://dryscope-migrate-test%40dryscope.iam@127.0.0.1:5432/dryscope'
    assert re.fullmatch(r'[0-9a-f]{64}', jobs['migrate']['env']['PROXY_SHA256'])


def test_smoke_before_traffic_and_rollback_only_after_a_move(release):
    deploy = steps(release['jobs']['deploy'])
    order = [step.get('id') or step.get('name') for step in deploy]
    stage = order.index('stage')
    smoke = order.index('Smoke-check the staged revision')
    promote = order.index('promote')
    after = order.index('Smoke-check the service URL')
    rollback = order.index('Roll back traffic')
    assert order.index('before') < stage < smoke < promote < after < rollback
    assert (
        'smoke-release.ts' in deploy[smoke]['run'] and '--commit "$COMMIT"' in deploy[smoke]['run']
    )
    assert deploy[smoke].get('if') is None and deploy[promote].get('if') is None
    condition = deploy[rollback]['if']
    assert 'failure()' in condition and 'cancelled()' in condition
    assert "steps.promote.outcome == 'success'" in condition
    assert '--to-revisions="$PREVIOUS"' in deploy[rollback]['run']


def test_ci_builds_and_smoke_checks_the_image_on_pull_requests():
    web = load(WEB)
    assert 'live-relay-placeholder/**' in web[True]['pull_request']['paths']
    image = run_text(web['jobs']['image'])
    assert 'smoke-release.ts --url http://127.0.0.1:8080' in image
    assert "'{{.Config.User}}'" in image


FROM = re.compile(r'^FROM (\S+)', re.MULTILINE)


@pytest.mark.parametrize('path', ['web/Dockerfile', 'live-relay-placeholder/Dockerfile'])
def test_images_are_pinned_and_run_unprivileged(path):
    text = (ROOT / path).read_text()
    bases = FROM.findall(text)
    assert bases
    for base in bases:
        assert re.fullmatch(r'node:[\w.-]+@sha256:[0-9a-f]{64}', base), base
    users = re.findall(r'^USER (\S+)', text, re.MULTILINE)
    assert users and users[-1] == 'node'


def test_web_image_carries_its_commit_and_no_env_files():
    text = (ROOT / 'web' / 'Dockerfile').read_text()
    assert "grep -Eqx '[0-9a-f]{40}'" in text
    assert 'APP_COMMIT=$COMMIT_SHA' in text
    assert 'CMD ["node", "server.js"]' in text
    ignored = (ROOT / 'web' / '.dockerignore').read_text().split()
    assert {'.env', '.env.*', 'node_modules', '.next'} <= set(ignored)


def test_live_placeholder_is_marked_and_holds_nothing():
    server = (ROOT / 'live-relay-placeholder' / 'server.js').read_text()
    assert 'PLACEHOLDER, NOT THE LIVE RELAY' in server
    assert 'require(' in server and re.findall(r"require\('([^']+)'\)", server) == ['node:http']
    assert '503' in server


def test_dependabot_keeps_the_pinned_base_images_current():
    updates = load(ROOT / '.github' / 'dependabot.yml')['updates']
    docker = set()
    for update in updates:
        if update['package-ecosystem'] == 'docker':
            docker.update(update.get('directories') or [update['directory']])
    assert {'/web', '/live-relay-placeholder'} <= docker
