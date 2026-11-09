"""Guards for the rebuilt app's test release path (.github/workflows/web-release.yml), its image
(web/Dockerfile) and the Live relay placeholder. Each test names a property the release relies on:
keyless sign-in as the right test account, pinned actions and images, no live or legacy target,
staging at 0% before any traffic moves, and rollback only after a move."""

import os
import re
import shlex
import subprocess
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


def stages(path):
    """Build stages by name (or index): each a list of (instruction, argument) pairs."""
    found = {}
    for line in instructions(path):
        op, _, arg = line.partition(' ')
        if op == 'FROM':
            words = arg.split()
            name = words[2] if len(words) == 3 and words[1].upper() == 'AS' else str(len(found))
            current = found[name] = []
        current.append((op, arg))
    return found


SHA = 'a' * 40
GOOD_PROVIDER = (
    'projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/providers/github'
)


class Shell:
    """Runs a step's shell the way Actions does (bash -eo pipefail), with fake commands that log
    their arguments and then run a given body."""

    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.bin = tmp_path / 'bin'
        self.bin.mkdir()
        self.log = tmp_path / 'calls.log'
        self.output = tmp_path / 'output'
        self.summary = tmp_path / 'summary'

    def fake(self, name, body='exit 0'):
        path = self.bin / name
        path.write_text(
            '#!/bin/bash\n'
            f"{{ printf '%s' {name}; printf '\\x1f%s' \"$@\"; printf '\\n'; }} >> '{self.log}'\n"
            f'{body}\n'
        )
        path.chmod(0o755)

    def run(
        self,
        script,
        env=None,
        cwd=None,
        interpreter=('bash', '--noprofile', '--norc', '-eo', 'pipefail'),
    ):
        full = {
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'HOME': str(self.tmp),
            'GITHUB_OUTPUT': str(self.output),
            'GITHUB_STEP_SUMMARY': str(self.summary),
            **(env or {}),
        }
        return subprocess.run(
            [*interpreter, '-c', script],
            env=full,
            cwd=cwd or self.tmp,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def calls(self, name=None):
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        found = [line.split('\x1f') for line in lines]
        return [args[1:] for args in found if name is None or args[0] == name]

    def outputs(self):
        lines = self.output.read_text().splitlines() if self.output.exists() else []
        return dict(line.split('=', 1) for line in lines)


@pytest.fixture
def shell(tmp_path):
    return Shell(tmp_path)


TOKEN = re.compile(r"\s*('(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*)")


LITERALS = {'true': True, 'false': False, 'null': None}


def evaluate(expression, context):
    """Evaluate the subset of the Actions expression language the workflow's `if` conditions use
    (string, boolean and null literals, property paths, ==, !=, !, &&, ||, parentheses and status functions) against
    context, where a missing property is null."""
    tokens, rest = [], expression.strip()
    while rest:
        match = TOKEN.match(rest)
        assert match, rest
        tokens.append(match.group(1))
        rest = rest[match.end() :].strip()
    position = 0

    def peek():
        return tokens[position] if position < len(tokens) else None

    def take(expected=None):
        nonlocal position
        token = tokens[position]
        assert expected is None or token == expected, (expected, token)
        position += 1
        return token

    def either():
        value = both()
        while peek() == '||':
            take()
            right = both()
            value = value or right
        return value

    def both():
        value = compare()
        while peek() == '&&':
            take()
            right = compare()
            value = value and right
        return value

    def compare():
        value = unary()
        while peek() in ('==', '!='):
            op, right = take(), unary()
            value = (value == right) if op == '==' else (value != right)
        return value

    def unary():
        if peek() == '!':
            take()
            return not unary()
        if peek() == '(':
            take()
            value = either()
            take(')')
            return value
        token = take()
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        if token in LITERALS:
            return LITERALS[token]
        if peek() == '(':
            take()
            take(')')
            return context[token]()
        value = context
        for part in token.split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    value = either()
    assert position == len(tokens), tokens[position:]
    return value


def workflow_run(**changes):
    run = {
        'conclusion': 'success',
        'event': 'push',
        'head_branch': 'master',
        'head_repository': {'full_name': 'owner/repo'},
    }
    return {
        'github': {
            'event_name': 'workflow_run',
            'ref': 'refs/heads/master',
            'repository': 'owner/repo',
            'event': {'workflow_run': {**run, **changes}},
        }
    }


def dispatch(ref):
    return {'github': {'event_name': 'workflow_dispatch', 'ref': ref, 'repository': 'owner/repo'}}


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
    assert release['env']['COMMIT'] == '${{ github.event.workflow_run.head_sha || github.sha }}'


@pytest.mark.parametrize(
    'context, runs',
    [
        (workflow_run(), True),
        (dispatch('refs/heads/master'), True),
        (workflow_run(conclusion='failure'), False),
        (workflow_run(conclusion='cancelled'), False),
        (workflow_run(event='pull_request'), False),
        (workflow_run(event='workflow_dispatch'), False),
        (workflow_run(event='schedule'), False),
        (workflow_run(event=None), False),
        (workflow_run(head_branch='feature'), False),
        (workflow_run(head_repository={'full_name': 'fork/repo'}), False),
        (dispatch('refs/heads/feature'), False),
        ({'github': {'event_name': 'push', 'ref': 'refs/heads/master'}}, False),
    ],
)
def test_gate_admits_only_a_passing_master_push_or_a_manual_master_run(release, context, runs):
    assert bool(evaluate(release['jobs']['gate']['if'], context)) is runs


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


def test_gate_reads_the_test_variables_and_later_jobs_wait_for_it(release):
    gate = step(release['jobs']['gate'], 'vars')
    assert gate['env'] == {
        'PROVIDER': '${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}',
        'DEPLOY_SA': '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
        'MIGRATE_SA': '${{ vars.DRYSCOPE_TEST_MIGRATE_SA }}',
    }
    build = release['jobs']['build']
    assert build['if'] == "needs.gate.outputs.ready == 'true'"
    assert step(build, 'image')['if'] == "steps.service.outputs.ready == 'true'"
    for name in ('migrate', 'deploy'):
        assert release['jobs'][name]['if'] == "needs.build.outputs.service_ready == 'true'"


GOOD_VARS = {
    'PROVIDER': GOOD_PROVIDER,
    'DEPLOY_SA': 'dryscope-deploy-test@dryscope.iam.gserviceaccount.com',
    'MIGRATE_SA': 'dryscope-migrate-test@dryscope.iam.gserviceaccount.com',
}


@pytest.mark.parametrize(
    'unset', [('PROVIDER', 'DEPLOY_SA', 'MIGRATE_SA'), ('PROVIDER',), ('MIGRATE_SA',)]
)
def test_gate_skips_while_any_variable_is_unset(release, shell, unset):
    given = {**GOOD_VARS, **{name: '' for name in unset}}
    result = shell.run(step(release['jobs']['gate'], 'vars')['run'], given)
    assert result.returncode == 0, result.stderr
    assert shell.outputs() == {'ready': 'false'}


def test_gate_is_ready_with_the_test_variables(release, shell):
    result = shell.run(step(release['jobs']['gate'], 'vars')['run'], GOOD_VARS)
    assert result.returncode == 0, result.stderr
    assert shell.outputs() == {'ready': 'true'}


@pytest.mark.parametrize(
    'wrong',
    [
        {'PROVIDER': GOOD_PROVIDER.replace('dryscope-test', 'dryscope-live')},
        {'PROVIDER': GOOD_PROVIDER.replace('570228742694', '123456789012')},
        {'PROVIDER': GOOD_PROVIDER + '/../other'},
        {'DEPLOY_SA': 'dryscope-deploy-live@dryscope.iam.gserviceaccount.com'},
        {'DEPLOY_SA': 'dryscope-migrate-test@dryscope.iam.gserviceaccount.com'},
        {'MIGRATE_SA': 'dryscope-migrate-live@dryscope.iam.gserviceaccount.com'},
        {'MIGRATE_SA': 'adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com'},
    ],
)
def test_gate_fails_on_variables_pointing_anywhere_but_test(release, shell, wrong):
    result = shell.run(step(release['jobs']['gate'], 'vars')['run'], {**GOOD_VARS, **wrong})
    assert result.returncode != 0
    assert shell.outputs().get('ready') != 'true'


@pytest.mark.parametrize('visible', [True, False])
def test_build_skips_until_the_deploy_account_sees_the_test_service(release, shell, visible):
    shell.fake('gcloud', 'exit 0' if visible else 'exit 1')
    result = shell.run(step(release['jobs']['build'], 'service')['run'], release['env'])
    assert result.returncode == 0, result.stderr
    assert shell.outputs() == {'ready': 'true' if visible else 'false'}
    (describe,) = shell.calls('gcloud')
    assert describe[:4] == ['run', 'services', 'describe', 'dryscope-api-test']
    assert {'--region=us-central1', '--project=dryscope'} <= set(describe)


def test_targets_only_the_test_environment_and_never_the_legacy_project(release):
    # Every value the workflow passes on: step inputs and environments.
    given = [str(v) for s in all_steps(release) for v in s.get('with', {}).values()]
    given += [str(v) for s in all_steps(release) for v in s.get('env', {}).values()]
    given += [str(v) for job in release['jobs'].values() for v in job.get('env', {}).values()]
    given += [str(v) for v in release['env'].values()]
    for text in given:
        for forbidden in ('dryscope-live', '-live@', 'alert-disaster', 'us-west2', 'firebase'):
            assert forbidden not in text, (forbidden, text[:80])
    # Every gcloud call reaches the test service through the workflow's own settings.
    for args in gcloud_calls(release):
        for flag, value in (('--project', '$PROJECT'), ('--region', '$REGION')):
            values = [arg.split('=', 1)[1] for arg in args if arg.split('=', 1)[0] == flag]
            assert values in ([], [value]), args
            if args[0] == 'run':
                assert values == [value], args
        if args[0] == 'run':
            assert [arg for arg in args if not arg.startswith('-')][-1] == '$SERVICE', args
    env = release['env']
    assert env['PROJECT'] == 'dryscope'
    assert env['REGION'] == 'us-central1'
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
    migrations = step(jobs['migrate'], 'migrations')
    url = migrations['env']['DATABASE_URL']
    assert url == 'postgres://dryscope-migrate-test%40dryscope.iam@127.0.0.1:5432/dryscope'
    assert re.fullmatch(r'[0-9a-f]{64}', jobs['migrate']['env']['PROXY_SHA256'])


def test_a_proxy_download_that_fails_its_checksum_never_runs(release, shell):
    job = release['jobs']['migrate']
    ran = shell.tmp / 'proxy-ran'
    shell.fake(
        'curl',
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n'
        f'printf \'#!/bin/sh\\ntouch {ran}\\n\' > "$out"',
    )
    result = shell.run(step(job, 'proxy')['run'], {**release['env'], **job['env']})
    assert result.returncode != 0
    assert not ran.exists()
    (download,) = shell.calls('curl')
    assert download[-1] == (
        'https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/'
        f'{job["env"]["PROXY_VERSION"]}/cloud-sql-proxy.linux.amd64'
    )


@pytest.mark.parametrize('passes', [True, False])
def test_the_migration_step_runs_the_ledger_and_fails_with_it(release, shell, passes):
    migrations = step(release['jobs']['migrate'], 'migrations')
    shell.fake('npm', 'exit 0' if passes else 'exit 1')
    result = shell.run(migrations['run'], migrations['env'])
    assert (result.returncode == 0) is passes
    assert shell.calls('npm') == [['run', 'db:migrate']]


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
    assert deploy[rollback]['env'] == {'PREVIOUS': '${{ steps.before.outputs.previous }}'}
    # The smoke script needs web/package.json ("type": "module") beside it.
    checkout = deploy[0]
    assert (
        checkout['uses'].startswith('actions/checkout@')
        and checkout['with']['sparse-checkout'] == 'web'
    )


@pytest.mark.parametrize(
    'promote, failed, cancelled, runs',
    [
        ('success', True, False, True),
        ('failure', True, False, True),
        ('cancelled', False, True, True),
        ('success', False, True, True),
        ('skipped', True, False, False),
        ('skipped', False, True, False),
        (None, True, False, False),
        ('success', False, False, False),
    ],
)
def test_rollback_runs_only_when_a_traffic_move_ran_and_the_job_did_not_pass(
    release, promote, failed, cancelled, runs
):
    context = {
        'steps': {'promote': {'outcome': promote}} if promote else {},
        'failure': lambda: failed,
        'cancelled': lambda: cancelled,
    }
    condition = step(release['jobs']['deploy'], 'Roll back traffic')['if']
    assert bool(evaluate(condition, context)) is runs


def test_rollback_restores_the_remembered_traffic_split(release, shell):
    rollback = step(release['jobs']['deploy'], 'Roll back traffic')
    shell.fake('gcloud')
    previous = 'dryscope-api-test-00007-abc=90,dryscope-api-test-00006-xyz=10'
    result = shell.run(rollback['run'], {**release['env'], 'PREVIOUS': previous})
    assert result.returncode == 0, result.stderr
    (move,) = shell.calls('gcloud')
    assert move[:4] == ['run', 'services', 'update-traffic', 'dryscope-api-test']
    assert set(move[4:]) == {
        f'--to-revisions={previous}',
        '--region=us-central1',
        '--project=dryscope',
        '--quiet',
    }


DOCKER = """case "$1 $2 $4" in
  'image inspect {{.Config.User}}') echo "$FAKE_USER" ;;
esac"""


def image_smoke_step():
    web = load(WEB)
    assert 'live-relay-placeholder/**' in web[True]['pull_request']['paths']
    return step(web['jobs']['image'], 'Run as on Cloud Run and smoke-check')


def test_ci_smoke_checks_the_image_as_test_on_pull_requests(shell):
    shell.fake('docker', DOCKER)
    shell.fake('node')
    result = shell.run(image_smoke_step()['run'], {'GITHUB_SHA': SHA, 'FAKE_USER': 'node'})
    assert result.returncode == 0, result.stderr
    (smoke,) = shell.calls('node')
    assert smoke == [
        'scripts/smoke-release.ts',
        '--url',
        'http://127.0.0.1:8080',
        '--commit',
        SHA,
        '--env',
        'test',
    ]
    (started,) = [args for args in shell.calls('docker') if args[0] == 'run']
    assert started[-1] == 'dryscope-web:ci'
    assert '127.0.0.1:8080:8080' in started and 'APP_ENV=test' in started


def test_ci_refuses_an_image_that_runs_as_root(shell):
    shell.fake('docker', DOCKER)
    shell.fake('node')
    result = shell.run(image_smoke_step()['run'], {'GITHUB_SHA': SHA, 'FAKE_USER': 'root'})
    assert result.returncode != 0
    assert shell.calls('node') == []
    assert [args for args in shell.calls('docker') if args[0] == 'run'] == []


def test_ci_fails_and_shows_the_logs_when_the_smoke_check_fails(shell):
    shell.fake('docker', DOCKER)
    shell.fake('node', 'exit 1')
    result = shell.run(image_smoke_step()['run'], {'GITHUB_SHA': SHA, 'FAKE_USER': 'node'})
    assert result.returncode != 0
    assert ['logs', 'web'] in shell.calls('docker')


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


def build_runs(shell, commit):
    """Run the build stage's RUN commands in order with sh, as docker build does, until one fails."""
    shell.fake('npm')
    build = stages(ROOT / 'web' / 'Dockerfile')['build']
    args = set()
    for op, arg in build:
        if op == 'ARG':
            args.add(arg.split('=', 1)[0])
        if op == 'RUN':
            env = {'COMMIT_SHA': commit} if 'COMMIT_SHA' in args else {}
            if shell.run(arg, env, interpreter=('sh',)).returncode != 0:
                return False
    return True


def test_web_image_builds_only_with_a_full_commit(shell):
    assert build_runs(shell, SHA)
    assert ['run', 'build'] in shell.calls('npm')


@pytest.mark.parametrize('commit', ['', 'main', SHA[:7], SHA.upper(), SHA + 'a'])
def test_web_image_refuses_to_build_without_a_full_commit(shell, commit):
    assert not build_runs(shell, commit)
    assert ['run', 'build'] not in shell.calls('npm')


def test_web_image_carries_its_commit_and_no_env_files():
    run = stages(ROOT / 'web' / 'Dockerfile')['run']
    assert ('ARG', 'COMMIT_SHA') in run
    env = {}
    for op, arg in run:
        if op == 'ENV':
            env.update(pair.split('=', 1) for pair in shlex.split(arg))
    assert env['APP_COMMIT'] == '$COMMIT_SHA'
    assert run.index(('ARG', 'COMMIT_SHA')) < [op for op, _ in run].index('ENV')
    assert run[-1] == ('CMD', '["node", "server.js"]')
    ignored = (ROOT / 'web' / '.dockerignore').read_text().split()
    assert {'.env', '.env.*', 'node_modules', '.next'} <= set(ignored)


def test_dependabot_keeps_the_pinned_base_images_current():
    updates = load(ROOT / '.github' / 'dependabot.yml')['updates']
    docker = set()
    for update in updates:
        if update['package-ecosystem'] == 'docker':
            docker.update(update.get('directories') or [update['directory']])
    assert {'/web', '/live-relay-placeholder'} <= docker
