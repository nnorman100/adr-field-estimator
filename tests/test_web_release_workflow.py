"""Guards for the rebuilt app's test release path (.github/workflows/web-release.yml), its images
(assembled without Docker by web/scripts/build-image.sh onto the base pinned in web/Dockerfile) and
the Live relay placeholder. Each test names a property the release relies on: keyless sign-in as the
right test account, pinned actions, tools and images, no live or legacy target, staging at 0% before
any traffic moves, and rollback only after a move."""

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
        ({'github': {**workflow_run()['github'], 'event_name': 'push'}}, False),
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
    # The web image is pushed on every ready run (the first app-root apply needs its digest); the
    # placeholder only until the deploy account can see the service.
    assert 'if' not in step(build, 'image')
    assert step(build, 'placeholder')['if'] == "steps.service.outputs.ready != 'true'"
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


# --- Images without a Docker daemon (owner decision 2026-11-10): web/scripts/build-image.sh -------

BASE_PIN = re.compile(r'node:[\w.-]+@sha256:[0-9a-f]{64}')
FAKE_BUILD = """mkdir -p .next/standalone/node_modules .next/static/chunks
echo server > .next/standalone/server.js
echo chunk > .next/static/chunks/main.js"""


def crane_fake(shell):
    """crane that logs its arguments and keeps a copy of the layer it was asked to append."""
    keep = shell.tmp / 'appended.tar'
    shell.fake(
        'crane',
        'prev=; for a in "$@"; do [ "$prev" = --append ] && cp "$a" '
        + f"'{keep}'"
        + '; prev=$a; done',
    )
    return keep


@pytest.fixture
def repo(tmp_path):
    """A copy of the files build-image.sh reads, so the real web/ build output is never touched."""
    root = tmp_path / 'repo'
    (root / 'web' / 'scripts').mkdir(parents=True)
    (root / 'web' / 'node_modules').mkdir()
    (root / 'live-relay-placeholder').mkdir()
    for name in (
        'web/scripts/build-image.sh',
        'web/Dockerfile',
        'live-relay-placeholder/server.js',
    ):
        (root / name).write_bytes((ROOT / name).read_bytes())
    (root / 'web/scripts/build-image.sh').chmod(0o755)
    return root


def layer_members(layer):
    listing = subprocess.run(
        ['tar', '-tvf', str(layer)], capture_output=True, text=True, check=True
    )
    return [line.split() for line in listing.stdout.splitlines()]


def test_the_base_image_is_pinned_once_and_nothing_else_is_built_with_docker():
    lines = instructions(ROOT / 'web' / 'Dockerfile')
    assert len(lines) == 1 and lines[0].startswith('FROM ')
    assert BASE_PIN.fullmatch(lines[0].split()[1])
    assert not (ROOT / 'live-relay-placeholder' / 'Dockerfile').exists()
    assert not (ROOT / 'web' / '.dockerignore').exists()


def test_web_image_appends_one_root_owned_app_layer_onto_the_pinned_base(shell, repo):
    keep = crane_fake(shell)
    shell.fake('npm', FAKE_BUILD)
    stage = shell.tmp / 'stage'
    script = (
        f'"{repo}/web/scripts/build-image.sh" web --commit {SHA} --output out.tar --stage "{stage}"'
    )
    result = shell.run(script)
    assert result.returncode == 0, result.stderr
    assert shell.calls('npm') == [['run', 'build']]
    (mutate,) = shell.calls('crane')
    base = instructions(ROOT / 'web' / 'Dockerfile')[0].split()[1]
    assert mutate[:4] == ['mutate', base, '--platform', 'linux/amd64']
    pairs = dict(zip(mutate[4::2], mutate[5::2]))
    assert pairs['--user'] == 'node' and pairs['--workdir'] == '/app'
    assert pairs['--cmd'] == 'node,server.js' and pairs['--output'] == 'out.tar'
    envs = [mutate[i + 1] for i, arg in enumerate(mutate) if arg == '--env']
    assert f'APP_COMMIT={SHA}' in envs and 'PORT=8080' in envs and 'NODE_ENV=production' in envs
    assert not [e for e in envs if e.startswith('APP_ENV=')]
    members = layer_members(keep)
    names = {m[-1] for m in members}
    assert {'app/server.js', 'app/.next/static/chunks/main.js'} <= names
    for mode, owner, *_ in members:
        assert owner == '0/0' and 'w' not in mode[4:], (mode, owner)
    assert (stage / 'app' / 'server.js').read_text() == 'server\n'


@pytest.mark.parametrize('commit', ['', 'main', SHA[:7], SHA.upper(), SHA + 'a'])
def test_web_image_refuses_to_build_without_a_full_commit(shell, repo, commit):
    crane_fake(shell)
    shell.fake('npm', FAKE_BUILD)
    script = f'"{repo}/web/scripts/build-image.sh" web --commit "{commit}" --output out.tar'
    assert shell.run(script).returncode != 0
    assert shell.calls('npm') == [] and shell.calls('crane') == []


def test_an_unpinned_base_is_refused(shell, repo):
    crane_fake(shell)
    (repo / 'web' / 'Dockerfile').write_text('FROM node:24-bookworm-slim\n')
    script = f'"{repo}/web/scripts/build-image.sh" live-placeholder --output out.tar'
    assert shell.run(script).returncode != 0
    assert shell.calls('crane') == []


def test_placeholder_image_carries_only_the_placeholder_and_no_commit(shell, repo):
    keep = crane_fake(shell)
    script = f'"{repo}/web/scripts/build-image.sh" live-placeholder --tag example/live:1'
    result = shell.run(script)
    assert result.returncode == 0, result.stderr
    (mutate,) = shell.calls('crane')
    assert mutate[-2:] == ['--tag', 'example/live:1']
    assert not [arg for arg in mutate if arg.startswith('APP_COMMIT=')]
    assert sorted(m[-1] for m in layer_members(keep)) == ['app/', 'app/server.js']


def test_a_crane_download_that_fails_its_checksum_is_never_unpacked(shell):
    shell.fake(
        'curl',
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\necho tampered > "$out"',
    )
    target = shell.tmp / 'tools'
    result = shell.run(f'"{ROOT}/web/scripts/install-crane.sh" "{target}"')
    assert result.returncode != 0
    assert not (target / 'crane').exists()
    (download,) = shell.calls('curl')
    assert re.fullmatch(
        r'https://github\.com/google/go-containerregistry/releases/download/v\d+\.\d+\.\d+/'
        r'go-containerregistry_\w+\.tar\.gz',
        download[-1],
    )


CRANE_REGISTRY = """case $1 in
  digest) if [ -e "$STATE" ]; then echo sha256:{digest}; else exit 1; fi ;;
esac""".replace('{digest}', 'b' * 64)


@pytest.mark.parametrize('pushed', [True, False])
def test_release_pushes_the_web_image_once_per_commit_and_hands_on_its_digest(
    release, shell, tmp_path, pushed
):
    image = step(release['jobs']['build'], 'image')
    state = tmp_path / 'pushed'
    if pushed:
        state.touch()
    shell.fake('crane', CRANE_REGISTRY)
    scripts = tmp_path / 'web' / 'scripts'
    scripts.mkdir(parents=True)
    build = scripts / 'build-image.sh'
    build.write_text(f'#!/bin/bash\necho "$@" >> "{tmp_path}/built"\ntouch "{state}"\n')
    build.chmod(0o755)
    env = {**release['env'], 'COMMIT': SHA, 'STATE': str(state)}
    result = shell.run(image['run'], env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    built = tmp_path / 'built'
    if pushed:
        assert not built.exists()
    else:
        assert built.read_text().split() == [
            'web',
            '--commit',
            SHA,
            '--tag',
            f'{release["env"]["IMAGE"]}:{SHA}',
        ]
    assert shell.outputs() == {'ref': f'{release["env"]["IMAGE"]}@sha256:{"b" * 64}'}


def test_release_refuses_an_unexpected_image_reference(release, shell, tmp_path):
    shell.fake('crane', 'echo not-a-digest')
    result = shell.run(
        step(release['jobs']['build'], 'image')['run'], {**release['env'], 'COMMIT': SHA}
    )
    assert result.returncode != 0
    assert 'ref' not in shell.outputs()


IMAGE_STEPS = ('Run as on Cloud Run and smoke-check', 'Refuse to start without APP_ENV')


def image_job():
    web = load(WEB)
    assert 'live-relay-placeholder/**' in web[True]['pull_request']['paths']
    return web['jobs']['image']


def test_ci_starts_the_image_tree_as_test_and_smoke_checks_it(shell):
    app = shell.tmp / 'web-stage' / 'app'
    app.mkdir(parents=True)
    shell.fake(
        'node',
        '[ "$1" = server.js ] && echo "$APP_ENV $APP_COMMIT $NODE_ENV $PORT" > started; exit 0',
    )
    result = shell.run(
        commands(step(image_job(), IMAGE_STEPS[0])),
        {'GITHUB_SHA': SHA, 'RUNNER_TEMP': str(shell.tmp)},
    )
    assert result.returncode == 0, result.stderr
    smoke = [args for args in shell.calls('node') if args[0] != 'server.js']
    assert smoke == [
        [
            'scripts/smoke-release.ts',
            '--url',
            'http://127.0.0.1:8080',
            '--commit',
            SHA,
            '--env',
            'test',
        ]
    ]
    for _ in range(50):
        if (app / 'started').exists():
            break
        subprocess.run(['sleep', '0.1'], check=True)
    assert (app / 'started').read_text().split() == ['test', SHA, 'production', '8080']


def test_ci_fails_and_shows_the_server_log_when_the_smoke_check_fails(shell):
    (shell.tmp / 'web-stage' / 'app').mkdir(parents=True)
    (shell.tmp / 'web.log').write_text('server said no\n')
    shell.fake('node', '[ "$1" = server.js ] && exit 0; exit 1')
    script = commands(step(image_job(), IMAGE_STEPS[0])).replace(
        ' > "$RUNNER_TEMP/web.log"', ' > /dev/null'
    )
    result = shell.run(script, {'GITHUB_SHA': SHA, 'RUNNER_TEMP': str(shell.tmp)})
    assert result.returncode != 0
    assert 'server said no' in result.stdout


@pytest.mark.parametrize('code, passes', [(1, True), (0, False), (124, False)])
def test_ci_requires_the_server_to_refuse_starting_without_app_env(shell, code, passes):
    (shell.tmp / 'web-stage' / 'app').mkdir(parents=True)
    shell.fake('node', f'exit {code}')
    result = shell.run(commands(step(image_job(), IMAGE_STEPS[1])), {'RUNNER_TEMP': str(shell.tmp)})
    assert (result.returncode == 0) is passes


def test_every_image_job_builds_through_the_script_and_never_calls_docker(release):
    for job in (image_job(), release['jobs']['build']):
        for s in steps(job):
            assert not re.search(r'(^|\s)docker\s', commands(s)), s.get('name', s.get('id'))
    assert 'scripts/build-image.sh web --commit "$GITHUB_SHA"' in commands(
        step(image_job(), 'Build the image without Docker')
    )


def test_dependabot_keeps_the_pinned_base_image_current():
    updates = load(ROOT / '.github' / 'dependabot.yml')['updates']
    docker = set()
    for update in updates:
        if update['package-ecosystem'] == 'docker':
            docker.update(update.get('directories') or [update['directory']])
    assert '/web' in docker
