"""Guards for the rebuilt app's test release path (.github/workflows/web-release.yml), its image
(web/Dockerfile) and the Live relay placeholder. Each test names a property the release relies on:
keyless sign-in as the right test account, pinned actions and images, no live or legacy target,
staging at 0% before any traffic moves, and rollback only after a move."""

import re
import shlex
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


def commands(step):
    """The shell a step runs, without comment lines, so a comment never satisfies a check."""
    lines = step.get('run', '').replace('\\\n', ' ').splitlines()  # join continuations
    return '\n'.join(line for line in lines if not line.strip().startswith('#'))


def step(job, key):
    """The one step whose id (or, failing that, name) is key."""
    (found,) = [s for s in steps(job) if s.get('id', s.get('name')) == key]
    return found


def all_steps(workflow):
    return [s for job in workflow['jobs'].values() for s in steps(job)]


def instructions(path):
    """Dockerfile instructions with comments dropped and continuation lines joined."""
    text = re.sub(r'\\\n', ' ', path.read_text())
    lines = (' '.join(line.split()) for line in text.splitlines())
    return [line for line in lines if line and not line.startswith('#')]


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
    uses = [s['uses'] for s in all_steps(load(path)) if 'uses' in s]
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
    for s in all_steps(release):
        assert 'credentials_json' not in s.get('with', {})


def test_skips_until_set_up_and_refuses_variables_pointing_anywhere_but_test(release):
    gate = step(release['jobs']['gate'], 'vars')
    assert gate['env'] == {
        'PROVIDER': '${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}',
        'DEPLOY_SA': '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
        'MIGRATE_SA': '${{ vars.DRYSCOPE_TEST_MIGRATE_SA }}',
    }
    shell = commands(gate)
    skip, check = shell.split('exit 0', 1)  # the skip branch ends the step before any check
    assert 'ready=false' in skip and 'ready=true' not in skip
    assert (
        '[[ "$PROVIDER" =~ ^projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/providers/'
        in check
    )
    assert '[ "$DEPLOY_SA" = "dryscope-deploy-test@dryscope.iam.gserviceaccount.com" ]' in check
    assert '[ "$MIGRATE_SA" = "dryscope-migrate-test@dryscope.iam.gserviceaccount.com" ]' in check
    build = release['jobs']['build']
    assert build['if'] == "needs.gate.outputs.ready == 'true'"
    assert step(build, 'image')['if'] == "steps.service.outputs.ready == 'true'"
    assert 'gcloud run services describe "$SERVICE"' in commands(step(build, 'service'))
    for name in ('migrate', 'deploy'):
        assert release['jobs'][name]['if'] == "needs.build.outputs.service_ready == 'true'"


def test_targets_only_the_test_environment_and_never_the_legacy_project(release):
    # Everything the workflow executes or passes on: commands, step inputs and environments.
    executed = [commands(s) for s in all_steps(release)]
    executed += [str(v) for s in all_steps(release) for v in s.get('with', {}).values()]
    executed += [str(v) for s in all_steps(release) for v in s.get('env', {}).values()]
    executed += [str(v) for job in release['jobs'].values() for v in job.get('env', {}).values()]
    executed += [str(v) for v in release['env'].values()]
    for text in executed:
        for forbidden in ('dryscope-live', '-live@', 'alert-disaster', 'us-west2', 'firebase'):
            assert forbidden not in text, (forbidden, text[:80])
    env = release['env']
    assert env['SERVICE'] == 'dryscope-api-test'
    assert env['IMAGE'].startswith('us-central1-docker.pkg.dev/dryscope/dryscope-test/')
    assert env['SQL_INSTANCE'] == 'dryscope:us-central1:dryscope-test-pg'


def gcloud_calls(workflow):
    """Every gcloud invocation the workflow runs, as argument lists ending at the first shell
    operator (pipe, ;, &&, ||, redirect or closing parenthesis)."""
    calls = []
    for s in all_steps(workflow):
        for line in commands(s).splitlines():
            _, found, rest = line.partition('gcloud ')
            if not found:
                continue
            lexer = shlex.shlex(rest, posix=True, punctuation_chars=True)
            lexer.whitespace_split = True
            args = []
            for token in lexer:
                if set(token) <= set('|&;()<>'):
                    break
                args.append(token)
            calls.append(args)
    return calls


def test_nothing_is_deleted_and_only_the_image_changes(release):
    calls = gcloud_calls(release)
    assert calls
    for args in calls:
        assert not {'delete', 'remove-tags', 'clear-tags'} & set(args), args
    (deploy,) = [args for args in calls if args[:2] == ['run', 'deploy']]
    flags = {arg.split('=', 1)[0] for arg in deploy[3:]}
    assert flags == {'--image', '--region', '--project', '--no-traffic', '--tag', '--quiet'}
    assert '--tag=candidate' in deploy and '--image=$IMAGE_REF' in deploy


def test_migrations_run_as_the_migrator_before_the_revision_is_staged(release):
    jobs = release['jobs']
    assert set(jobs['deploy']['needs']) == {'build', 'migrate'}
    proxy = commands(step(jobs['migrate'], 'proxy'))
    assert proxy.index('sha256sum --check --strict') < proxy.index(
        './cloud-sql-proxy --auto-iam-authn'
    )
    migrations = step(jobs['migrate'], 'migrations')
    assert 'npm run db:migrate' in commands(migrations)
    url = migrations['env']['DATABASE_URL']
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
    assert shlex.split(commands(deploy[smoke])) == [
        'node',
        'web/scripts/smoke-release.ts',
        '--url',
        '$CANDIDATE_URL',
        '--commit',
        '$COMMIT',
        '--env',
        'test',
    ]
    assert deploy[smoke].get('if') is None and deploy[promote].get('if') is None
    condition = deploy[rollback]['if']
    assert condition.startswith('(failure() || cancelled()) && (')
    for outcome in ('success', 'failure', 'cancelled'):
        assert f"steps.promote.outcome == '{outcome}'" in condition
    assert deploy[rollback]['env'] == {'PREVIOUS': '${{ steps.before.outputs.previous }}'}
    assert '--to-revisions="$PREVIOUS"' in commands(deploy[rollback])
    # The smoke script needs web/package.json ("type": "module") beside it.
    checkout = deploy[0]
    assert (
        checkout['uses'].startswith('actions/checkout@')
        and checkout['with']['sparse-checkout'] == 'web'
    )


def test_ci_builds_and_smoke_checks_the_image_on_pull_requests():
    web = load(WEB)
    assert 'live-relay-placeholder/**' in web[True]['pull_request']['paths']
    image = '\n'.join(commands(s) for s in steps(web['jobs']['image']))
    assert (
        'node scripts/smoke-release.ts --url http://127.0.0.1:8080 --commit "$GITHUB_SHA" --env test'
        in image
    )
    assert (
        'test "$(docker image inspect --format \'{{.Config.User}}\' dryscope-web:ci)" = node'
        in image
    )


@pytest.mark.parametrize('path', ['web/Dockerfile', 'live-relay-placeholder/Dockerfile'])
def test_images_are_pinned_and_run_unprivileged(path):
    lines = instructions(ROOT / path)
    bases = [line.split()[1] for line in lines if line.startswith('FROM ')]
    assert bases
    for base in bases:
        assert re.fullmatch(r'node:[\w.-]+@sha256:[0-9a-f]{64}', base), base
    # The final stage, the one that ships, runs as the unprivileged node user.
    final = lines[max(i for i, line in enumerate(lines) if line.startswith('FROM ')) :]
    users = [line.split()[1] for line in final if line.startswith('USER ')]
    assert users == ['node']


def test_web_image_carries_its_commit_and_no_env_files():
    lines = instructions(ROOT / 'web' / 'Dockerfile')
    build_check = [line for line in lines if line.startswith('RUN ') and 'COMMIT_SHA' in line]
    assert build_check == [
        'RUN echo "$COMMIT_SHA" | grep -Eqx \'[0-9a-f]{40}\' '
        "|| { echo 'Pass --build-arg COMMIT_SHA=<40-character commit>' >&2; exit 1; }"
    ]
    run_env = [line for line in lines if line.startswith('ENV ') and 'APP_COMMIT' in line]
    assert len(run_env) == 1 and 'APP_COMMIT=$COMMIT_SHA' in run_env[0].split()
    assert lines[-1] == 'CMD ["node", "server.js"]'
    ignored = (ROOT / 'web' / '.dockerignore').read_text().split()
    assert {'.env', '.env.*', 'node_modules', '.next'} <= set(ignored)


def test_dependabot_keeps_the_pinned_base_images_current():
    updates = load(ROOT / '.github' / 'dependabot.yml')['updates']
    docker = set()
    for update in updates:
        if update['package-ecosystem'] == 'docker':
            docker.update(update.get('directories') or [update['directory']])
    assert {'/web', '/live-relay-placeholder'} <= docker
