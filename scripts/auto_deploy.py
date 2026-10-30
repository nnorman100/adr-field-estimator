"""Release a CI-tested master commit to production with the manual release flow's safety.

Run by .github/workflows/deploy.yml after the CI workflow succeeds on a push to master. It reuses the
manual path instead of replacing it: scripts/deploy_backend.py stages a tagged 0% revision with the
production baseline, the staged health and signed-out refusal checks run against the tagged URL,
traffic is promoted only if they pass, then the Hosting shell is stamped, only hosting:alert-disaster
is deployed and scripts/verify_hosting.js verifies it. A failure before promotion promotes nothing. A
failure after promotion puts traffic back on the revision that was serving (and Hosting back on its
previous version) and fails the run.

It refuses, with a message, anything the owner must release by hand: a merge that changed
firestore.rules or firestore.indexes.json since the serving commit, a serving revision whose commit is
unknown or not an ancestor of the candidate, a staged revision whose environment, secrets or limits
differ from the serving one beyond the three baseline flags, or a Firestore TTL policy that is missing.
A candidate that is already serving, or older than what is serving, is skipped without error so
overlapping runs and manual releases never move production backwards.

The release record goes to the Actions job summary (GITHUB_STEP_SUMMARY), because automation cannot
commit to protected master; manual releases still append RELEASES.md rows.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.deploy_backend import (
    DEFAULT_AI_FEATURES,
    PROJECT,
    env_assignments,
)

SERVICE = 'alert-disaster-field-estimator'
REGION = 'us-west2'
HOSTING_TARGET = 'hosting:alert-disaster'
# The production baseline passed to deploy_backend.py (docs/firebase-isolation.md, RELEASES.md).
WORKSPACES = 'on'
AI_FEATURES = DEFAULT_AI_FEATURES
PRICE_BOOKS = 'off'
# The firebase-tools version CI already uses.
FIREBASE_TOOLS = 'firebase-tools@15.31.0'
# A merge touching these is released by hand: the workflow never deploys rules or indexes.
HAND_RELEASED = ('firestore.rules', 'firestore.indexes.json')
# deploy_backend.py sets these on every revision; any other difference from the serving revision is a bug.
BASELINE_KEYS = tuple(env_assignments(WORKSPACES, AI_FEATURES, PRICE_BOOKS))
COMMIT = re.compile(r'[0-9a-f]{40}')
# Signed-out requests that the staged revision must refuse with 401 (RELEASES.md staged checks).
REFUSED_GET = (
    '/api/session',
    '/api/access',
    '/api/admin/companies',
    '/api/inspections',
    '/api/authorizations',
)
REFUSED_POST = ('/api/live', '/api/audit')


class Refused(RuntimeError):
    """The release cannot proceed safely; nothing was promoted by this refusal."""


class Skipped(RuntimeError):
    """Nothing to release; not a failure."""


class Runner:
    """The only place that touches the outside world, so tests can replace it."""

    def __init__(self, root=ROOT, sleep=time.sleep):
        self.root = root
        self.sleep = sleep
        self.gcloud = shutil.which('gcloud') or 'gcloud'

    def run(self, argv, capture=True, check=True):
        result = subprocess.run(argv, cwd=self.root, capture_output=capture, text=True)
        if check and result.returncode:
            detail = (result.stderr or '').strip()[-2000:] if capture else ''
            raise Refused(f'{" ".join(argv[:4])} failed with exit {result.returncode}. {detail}')
        return result

    def fetch(self, url, method='GET', body=None, headers=None, timeout=30):
        request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read().decode('utf8', 'replace')
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode('utf8', 'replace')
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return 0, str(error)


class Record:
    """The facts a RELEASES.md row holds, written to the Actions job summary as they are learned."""

    def __init__(self, path=None):
        self.path = path
        self.facts = {}
        self.log = []

    def note(self, line):
        print(line, flush=True)
        self.log.append(line)
        self.append(f'- {line}\n')

    def set(self, key, value):
        self.facts[key] = value

    def append(self, text):
        if self.path:
            with open(self.path, 'a', encoding='utf8') as handle:
                handle.write(text)

    def table(self, outcome):
        rows = [('Outcome', outcome), *self.facts.items()]
        return '\n### Release record\n\n| Fact | Value |\n| --- | --- |\n' + ''.join(
            f'| {key} | {value} |\n' for key, value in rows
        )


def git(runner, *args, check=True):
    return runner.run(['git', *args], check=check)


def gcloud_json(runner, *args):
    argv = [runner.gcloud, *args, f'--project={PROJECT}', '--format=json']
    return json.loads(runner.run(argv).stdout or '{}')


def service_state(runner):
    return gcloud_json(
        runner,
        'run',
        'services',
        'describe',
        SERVICE,
        f'--region={REGION}',
        f'--billing-project={PROJECT}',
    )


def serving_revision(service):
    """The one revision holding 100% of traffic; any split or unresolved target is refused."""
    traffic = [t for t in service.get('status', {}).get('traffic', []) if t.get('percent')]
    if len(traffic) != 1 or traffic[0].get('percent') != 100 or not traffic[0].get('revisionName'):
        raise Refused(
            'Traffic is not 100% on one named revision, so the rollback target is ambiguous: '
            + json.dumps(traffic)
            + '. Release by hand.'
        )
    return traffic[0]['revisionName']


def tagged_url(service, tag, revision=None):
    for entry in service.get('status', {}).get('traffic', []):
        if entry.get('tag') == tag and entry.get('url'):
            if revision and entry.get('revisionName') != revision:
                continue
            return entry['url'].rstrip('/'), entry.get('revisionName')
    raise Refused(f'No tagged URL for {tag!r} on the service after staging.')


def revision_state(runner, name):
    return gcloud_json(
        runner,
        'run',
        'revisions',
        'describe',
        name,
        f'--region={REGION}',
        f'--billing-project={PROJECT}',
    )


def revision_commit(revision):
    label = revision.get('metadata', {}).get('labels', {}).get('source-commit', '')
    if not COMMIT.fullmatch(label):
        raise Refused(
            f'The serving revision reports source-commit {label!r}, not a clean commit, so '
            'what changed since it cannot be judged. Release by hand.'
        )
    return label


def spec_summary(revision):
    """Everything a release must preserve: environment, secret bindings, identity and limits."""
    spec = revision.get('spec', {})
    containers = spec.get('containers') or []
    if len(containers) != 1:
        raise Refused(f'Expected one container, found {len(containers)}.')
    env = {}
    for item in containers[0].get('env') or []:
        secret = (item.get('valueFrom') or {}).get('secretKeyRef')
        env[item['name']] = (
            f'secret:{secret.get("name")}:{secret.get("key")}' if secret else item.get('value', '')
        )
    return {
        'env': env,
        'serviceAccount': spec.get('serviceAccountName'),
        'concurrency': spec.get('containerConcurrency'),
        'timeoutSeconds': spec.get('timeoutSeconds'),
        'limits': (containers[0].get('resources') or {}).get('limits') or {},
    }


def spec_differences(serving, staged):
    """Differences beyond the baseline flags, plus any baseline flag the stage did not set as asked."""
    found = []
    want = env_assignments(WORKSPACES, AI_FEATURES, PRICE_BOOKS)
    for key, value in want.items():
        if staged['env'].get(key) != value:
            found.append(
                f'{key} on the staged revision is {staged["env"].get(key)!r}, not {value!r}'
            )
    for key in sorted(set(serving['env']) | set(staged['env'])):
        if key in BASELINE_KEYS:
            continue
        if serving['env'].get(key) != staged['env'].get(key):
            found.append(
                f'{key}: serving {serving["env"].get(key, "(unset)")!r}, '
                f'staged {staged["env"].get(key, "(unset)")!r}'
            )
    for key in ('serviceAccount', 'concurrency', 'timeoutSeconds', 'limits'):
        if serving[key] != staged[key]:
            found.append(f'{key}: serving {serving[key]!r}, staged {staged[key]!r}')
    return found


def baseline_notes(serving, staged):
    """Baseline flags that this release changes from the serving revision, for the record."""
    return [
        f'{key} {serving["env"].get(key, "(unset)")!r} -> {staged["env"].get(key, "(unset)")!r}'
        for key in BASELINE_KEYS
        if serving['env'].get(key) != staged['env'].get(key)
    ]


def check_candidate(runner, commit, serving_commit):
    """Decide skip or refuse from the commits alone; return the files changed since the serving one."""
    if git(runner, 'rev-parse', 'HEAD').stdout.strip() != commit:
        raise Refused('The checkout is not the CI-tested commit.')
    if git(runner, 'merge-base', '--is-ancestor', commit, 'origin/master', check=False).returncode:
        raise Refused(f'{commit} is not on master; only master commits are released.')
    if serving_commit == commit:
        raise Skipped(f'{commit[:12]} is already serving.')
    if git(runner, 'cat-file', '-e', serving_commit + '^{commit}', check=False).returncode:
        raise Refused(
            f'Serving commit {serving_commit[:12]} is not in this checkout. Release by hand.'
        )
    if (
        git(runner, 'merge-base', '--is-ancestor', commit, serving_commit, check=False).returncode
        == 0
    ):
        raise Skipped(
            f'{commit[:12]} is older than the serving {serving_commit[:12]}; not moving back.'
        )
    if git(runner, 'merge-base', '--is-ancestor', serving_commit, commit, check=False).returncode:
        raise Refused(
            f'Serving commit {serving_commit[:12]} is not an ancestor of {commit[:12]}. Release by hand.'
        )
    names = git(runner, 'diff', '--name-only', f'{serving_commit}..{commit}').stdout.split()
    return names


def check_hand_released(names):
    changed = [name for name in HAND_RELEASED if name in names]
    if changed:
        raise Refused(
            f'{", ".join(changed)} changed since the serving commit. Automatic deploys never '
            'release Firestore rules or indexes: deploy them by hand '
            '(docs/firebase-isolation.md, Deployment), confirm the indexes are READY, then release '
            'this commit by hand; later merges deploy automatically again.'
        )


def check_ttls(runner):
    result = runner.run([sys.executable, 'scripts/ensure_firestore_ttls.py'], check=False)
    if result.returncode:
        raise Refused(
            'The read-only Firestore TTL check failed:\n'
            + (result.stdout or '')
            + (result.stderr or '')
            + '\nRun scripts/ensure_firestore_ttls.py --apply by hand if a policy is missing.'
        )


def staged_checks(runner, url, commit):
    """Health (with retries for a cold start) and signed-out refusals, against the tagged URL."""
    failures = []
    for attempt in range(6):
        status, body = runner.fetch(url + '/api/health')
        try:
            health = json.loads(body)
        except ValueError:
            health = {}
        if (
            status == 200
            and health.get('status') == 'healthy'
            and health.get('schema_version') == 3
            and health.get('source_commit') == commit
        ):
            break
        if attempt == 5:
            failures.append(
                f'/api/health answered {status} {body[:200]!r}; wanted healthy, schema 3, {commit}'
            )
        else:
            runner.sleep(10)
    for path in REFUSED_GET:
        status, _ = runner.fetch(url + path)
        if status != 401:
            failures.append(f'signed-out GET {path} answered {status}, not 401')
    for path in REFUSED_POST:
        status, _ = runner.fetch(
            url + path, method='POST', body=b'{}', headers={'Content-Type': 'application/json'}
        )
        if status != 401:
            failures.append(f'signed-out POST {path} answered {status}, not 401')
    if failures:
        raise Refused('Staged checks failed; nothing was promoted:\n' + '\n'.join(failures))


def hosting_release(runner):
    """The live Hosting release and version, from the Hosting API with the job's own credentials."""
    token = runner.run([runner.gcloud, 'auth', 'print-access-token']).stdout.strip()
    status, body = runner.fetch(
        f'https://firebasehosting.googleapis.com/v1beta1/sites/{PROJECT}/channels/live/releases?pageSize=1',
        headers={'Authorization': 'Bearer ' + token, 'x-goog-user-project': PROJECT},
    )
    if status != 200:
        raise Refused(f'Hosting release lookup failed with HTTP {status}.')
    release = json.loads(body)['releases'][0]
    return {
        'release': release['name'].rsplit('/', 1)[-1],
        'version': release['version']['name'].rsplit('/', 1)[-1],
    }


def firebase(runner, *args):
    return runner.run(
        ['npx', '--yes', FIREBASE_TOOLS, *args, f'--project={PROJECT}'], capture=False
    )


def promote(runner, tag):
    runner.run(
        [
            runner.gcloud,
            'run',
            'services',
            'update-traffic',
            SERVICE,
            f'--to-tags={tag}=100',
            f'--region={REGION}',
            f'--project={PROJECT}',
            f'--billing-project={PROJECT}',
        ]
    )


def restore_traffic(runner, revision):
    runner.run(
        [
            runner.gcloud,
            'run',
            'services',
            'update-traffic',
            SERVICE,
            f'--to-revisions={revision}=100',
            f'--region={REGION}',
            f'--project={PROJECT}',
            f'--billing-project={PROJECT}',
        ]
    )
    if serving_revision(service_state(runner)) != revision:
        raise Refused(f'Traffic read-back is not 100% on {revision}.')


def restore_hosting(runner, before):
    firebase(runner, 'hosting:clone', f'{PROJECT}@{before["version"]}', f'{PROJECT}:live')
    now = hosting_release(runner)
    if now['version'] != before['version']:
        raise Refused(f'Hosting read-back is version {now["version"]}, not {before["version"]}.')


def roll_back(runner, record, previous, hosting_before, hosting_deployed):
    problems = []
    for what, action in (
        (f'traffic to {previous}', lambda: restore_traffic(runner, previous)),
        *(
            [
                (
                    f'Hosting to version {hosting_before["version"]}',
                    lambda: restore_hosting(runner, hosting_before),
                )
            ]
            if hosting_deployed
            else []
        ),
    ):
        try:
            action()
            record.note(f'Rolled back {what}.')
        except Refused as error:
            problems.append(f'Rollback of {what} failed: {error}')
            record.note(problems[-1])
    record.set('Rollback', 'completed' if not problems else 'FAILED, restore by hand')
    return problems


def release(runner, record, commit, tag, check_only=False):
    service = service_state(runner)
    previous = serving_revision(service)
    serving = revision_state(runner, previous)
    serving_commit = revision_commit(serving)
    record.set('Source commit', f'`{commit}`')
    record.set('Rollback pair (serving before)', f'backend `{previous}` at `{serving_commit}`')
    names = check_candidate(runner, commit, serving_commit)
    check_hand_released(names)
    check_ttls(runner)
    record.note(
        'Candidate is newer than the serving commit; no rules or indexes changed; TTL policies in place.'
    )
    if check_only:
        record.note('Check only: nothing staged or deployed.')
        return
    hosting_before = hosting_release(runner)
    record.set(
        'Rollback pair (Hosting before)',
        f'release `{hosting_before["release"]}` / version `{hosting_before["version"]}`',
    )

    runner.run(
        [
            sys.executable,
            'scripts/deploy_backend.py',
            '--workspaces',
            WORKSPACES,
            '--ai-features',
            AI_FEATURES,
            '--price-books',
            PRICE_BOOKS,
            '--tag',
            tag,
            '--yes',
        ],
        capture=False,
    )
    url, staged_name = tagged_url(service_state(runner), tag)
    record.set('Backend revision (tag)', f'`{staged_name}` (tag `{tag}`)')
    if staged_name == previous:
        raise Refused('Staging produced no new revision.')
    staged = spec_summary(revision_state(runner, staged_name))
    differences = spec_differences(spec_summary(serving), staged)
    if differences:
        raise Refused(
            'The staged revision does not preserve the serving revision; nothing was promoted:\n'
            + '\n'.join(differences)
        )
    for line in baseline_notes(spec_summary(serving), staged):
        record.note('Baseline change: ' + line)
    staged_checks(runner, url, commit)
    record.set(
        'Staged checks',
        f'passed at {url}: health (schema 3, source commit), signed-out 401s, TTL policies',
    )
    record.note(f'Staged {staged_name} at 0% and its checks passed.')

    hosting_deployed = False
    try:
        promote(runner, tag)
        record.set('Backend traffic', '100% (promoted)')
        record.note(f'Promoted {staged_name} to 100%.')
        runner.run([sys.executable, 'scripts/stamp_hosting.py'], capture=False)
        hosting_deployed = True
        firebase(runner, 'deploy', '--only', HOSTING_TARGET)
        hosting_after = hosting_release(runner)
        if hosting_after['release'] == hosting_before['release']:
            hosting_deployed = False
            raise Refused('Hosting deploy created no new release.')
        record.set(
            'Frontend (Hosting)',
            f'`{commit}` (Hosting version `{hosting_after["version"]}`, release `{hosting_after["release"]}`)',
        )
        runner.run(['node', 'scripts/verify_hosting.js'], capture=False)
        record.set('Hosting verification', 'scripts/verify_hosting.js passed')
        record.note('Hosting released and verified.')
    except Exception as error:
        record.note(f'FAILED after promotion: {error}')
        problems = roll_back(runner, record, previous, hosting_before, hosting_deployed)
        record.set('Backend traffic', f'rolled back to `{previous}`')
        raise Refused(
            f'Release failed after promotion and was rolled back: {error}'
            + ('\n' + '\n'.join(problems) if problems else '')
        ) from error
    finally:
        runner.run([sys.executable, 'scripts/stamp_hosting.py', '--reset'], check=False)


def main(argv=None, runner=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--commit', required=True, help='the CI-tested commit; must be checked out')
    parser.add_argument('--tag', help='revision URL tag (default: auto-<commit prefix>)')
    parser.add_argument(
        '--check-only',
        action='store_true',
        help='run every refusal check; stage and deploy nothing',
    )
    args = parser.parse_args(argv)
    if not COMMIT.fullmatch(args.commit):
        print('--commit must be a full lowercase commit hash.', file=sys.stderr)
        return 2
    tag = args.tag or 'auto-' + args.commit[:12]
    runner = runner or Runner()
    record = Record(os.environ.get('GITHUB_STEP_SUMMARY'))
    record.append('## Production release\n\n')
    outcome = 'FAILED'
    try:
        release(runner, record, args.commit, tag, args.check_only)
        outcome = 'checked, nothing deployed' if args.check_only else 'released'
        return 0
    except Skipped as notice:
        outcome = 'skipped'
        record.note(f'Skipped: {notice}')
        return 0
    except Refused as error:
        outcome = 'refused or failed'
        record.note(f'{error}')
        print(f'::error::{str(error).splitlines()[0]}', file=sys.stderr)
        return 1
    finally:
        record.append(record.table(outcome))


if __name__ == '__main__':
    sys.exit(main())
