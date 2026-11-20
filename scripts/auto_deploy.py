"""Historical release CLI for the retired app. Its project is never deployed to or changed.

Historical: this CLI released the retired old app. That project is switched off and is never deployed
to or changed (docs/architecture/product-rules.md); the CLI is kept only as a record. It used the manual
release path:
scripts/deploy_backend.py stages a tagged 0% revision with the
production baseline, the staged health and signed-out refusal checks run against the tagged URL,
traffic is promoted only if they pass, then the Hosting shell is stamped, only hosting:alert-disaster
is deployed and scripts/verify_hosting.js verifies it. A failure before promotion promotes nothing. A
failure after promotion puts traffic back on the revision that was serving (and Hosting back on its
previous version) and fails the run.

It refused, with a message, anything that historically had to be released by hand: a merge that changed
firestore.rules or firestore.indexes.json since the serving commit, a serving revision whose commit is
unknown or not an ancestor of the candidate, a staged revision whose environment, secrets or limits
differ from the serving one beyond the three baseline flags, a service without the one-instance minimum,
a serving revision with no STAFF_EMAILS,
a Firestore TTL policy that is missing, or a repository baseline less permissive than the serving
revision. That last one stops before staging unless the owner passes --confirm-baseline.
A candidate that is already serving, or older than what is serving, is skipped without error so
overlapping runs and manual releases never move production backwards. So is a candidate whose changes
since the serving commit touch no file the legacy app is built from (LEGACY_PREFIXES and LEGACY_FILES
in auto_deploy_helpers.py): DryScope rebuild merges (web/, infra/, docs) never release it.

The CLI writes to GITHUB_STEP_SUMMARY when present. Historical manual releases were recorded in RELEASES.md.

--publish creates the git tag and GitHub Release for the version the live backend reports. --rollback
redeploys an earlier version and stops before staging when a data migration is newer than that version,
or Firestore rules or indexes changed since it, unless --confirm-past-migration is given. It stages the
target's code with the baseline of the checkout running it.
--next-version prints the number a historical hand release used.
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
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.deploy_backend import (
    DEFAULT_AI_FEATURES,
    DEFAULT_PRICE_BOOKS,
    DEFAULT_RETENTION,
    MIN_INSTANCES,
    PROJECT,
    env_assignments,
    staff_emails_value,
)
from scripts.release_stamp import valid_version
from scripts.auto_deploy_helpers import (
    Refused,
    Skipped,
    Runner,
    Record,
    git,
    legacy_skip_reason,
    version_tags_at,
    next_version,
    plain_commit_line,
    previous_version,
    release_notes,
)

SERVICE = 'alert-disaster-field-estimator'
REGION = 'us-west2'
# The service-level minimum instance count, as a service annotation (not the revision's minScale).
SERVICE_MIN_SCALE = 'run.googleapis.com/minScale'
HOSTING_TARGET = 'hosting:alert-disaster'
# The production baseline passed to deploy_backend.py, which owns the constants a turn-on PR changes
# (docs/firebase-isolation.md, "Turning a feature on or off").
WORKSPACES = 'on'
AI_FEATURES = DEFAULT_AI_FEATURES
PRICE_BOOKS = DEFAULT_PRICE_BOOKS
RETENTION = DEFAULT_RETENTION
# The firebase-tools version CI already uses.
FIREBASE_TOOLS = 'firebase-tools@15.31.0'
# Historically, changed rules or indexes were handled separately from the CLI release.
HAND_RELEASED = ('firestore.rules', 'firestore.indexes.json')
# deploy_backend.py sets these on every revision; any other difference from the serving revision is a bug.
BASELINE_KEYS = tuple(env_assignments(WORKSPACES, AI_FEATURES, PRICE_BOOKS, RETENTION))
COMMIT = re.compile(r'[0-9a-f]{40}')
# Cloud Run rejects a traffic tag when tag + service name exceed this many characters.
TAG_LIMIT = 46
TAG_FORM = re.compile(r'[a-z][a-z0-9-]*')


def check_tag(tag, service=SERVICE):
    """Refuse a tag Cloud Run would reject, before anything is staged."""
    if not TAG_FORM.fullmatch(tag):
        raise Refused(
            f'Traffic tag {tag!r} must be lowercase letters, digits and dashes, starting with a letter.'
        )
    if len(tag) + len(service) > TAG_LIMIT:
        raise Refused(
            f'Traffic tag {tag!r} ({len(tag)}) and service name {service!r} ({len(service)}) exceed '
            f"Cloud Run's {TAG_LIMIT}-character limit."
        )
    return tag


def default_tag(commit, run_id='', service=SERVICE):
    """'a<commit prefix>-<run id>', unique per run, with the run id's trailing digits trimmed to fit."""
    head = 'a' + commit[:7]
    room = TAG_LIMIT - len(service) - len(head) - 1
    digits = re.sub(r'\D', '', run_id)[-room:] if room > 0 else ''
    return check_tag(f'{head}-{digits}' if digits else head, service)


# Signed-out requests that the staged revision must refuse with 401 (RELEASES.md staged checks).
REFUSED_GET = (
    '/api/session',
    '/api/access',
    '/api/admin/companies',
    '/api/inspections',
    '/api/authorizations',
)
REFUSED_POST = ('/api/live', '/api/audit')


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
            + '. The CLI does not proceed; this was historically a by-hand release.'
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
            'what changed since it cannot be judged. The CLI does not proceed; this was historically a by-hand release.'
        )
    return label


def service_min_instances(service):
    """The service-level minimum instance count; unset or unreadable counts as zero."""
    value = str((service.get('metadata', {}).get('annotations') or {}).get(SERVICE_MIN_SCALE, '0'))
    return int(value) if value.isdigit() else 0


def spec_summary(revision, service):
    """Everything a release must preserve: environment, secret bindings, identity, limits and the
    service-level minimum."""
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
        'minInstances': service_min_instances(service),
    }


def serving_staff_emails(summary):
    """The serving STAFF_EMAILS, normalized as deploy_backend.py sets it; refuse when it is missing."""
    try:
        value = staff_emails_value(summary['env'].get('STAFF_EMAILS', ''))
    except argparse.ArgumentTypeError as error:
        raise Refused(
            f'The serving revision has no usable STAFF_EMAILS ({error}). Releasing without it would '
            'leave the legacy workspaces-off mode admitting nobody. Nothing was staged or deployed.'
        ) from None
    summary['env']['STAFF_EMAILS'] = value
    return value


def spec_differences(serving, staged):
    """Differences beyond the baseline flags, plus any baseline flag the stage did not set as asked."""
    found = []
    want = env_assignments(WORKSPACES, AI_FEATURES, PRICE_BOOKS, RETENTION)
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
    # Like the baseline flags, the minimum is the repository's setting, so the service after staging
    # is held to it rather than to the service before, which may predate it.
    if staged['minInstances'] != MIN_INSTANCES:
        found.append(
            f'minInstances on the service is {staged["minInstances"]!r}, not {MIN_INSTANCES!r}'
        )
    return found


def baseline_notes(serving, staged):
    """Baseline settings that this release changes from the serving revision, for the record."""
    notes = [
        f'{key} {serving["env"].get(key, "(unset)")!r} -> {staged["env"].get(key, "(unset)")!r}'
        for key in BASELINE_KEYS
        if serving['env'].get(key) != staged['env'].get(key)
    ]
    if serving['minInstances'] != staged['minInstances']:
        notes.append(f'minInstances {serving["minInstances"]!r} -> {staged["minInstances"]!r}')
    return notes


def enabled_ai_features(value):
    """The names the server enables from an AI_FEATURES value (backend/ai_features.py)."""
    return frozenset(filter(None, (name.strip().lower() for name in value.split(','))))


def baseline_reductions(serving):
    """(setting, constant, line) for each serving feature the repository baseline would turn off.

    Values are read the way the server reads them, so an unset flag counts as off.
    """
    env = serving['env']
    want = env_assignments(WORKSPACES, AI_FEATURES, PRICE_BOOKS, RETENTION)
    found = []
    # backend/price_books.py: price_books_enabled.
    if env.get('PRICE_BOOKS_ENABLED', '').lower() == 'true' and PRICE_BOOKS != 'on':
        found.append(
            (
                'PRICE_BOOKS_ENABLED',
                'DEFAULT_PRICE_BOOKS',
                f'PRICE_BOOKS_ENABLED: serving {env["PRICE_BOOKS_ENABLED"]!r}, repository baseline '
                f'{want["PRICE_BOOKS_ENABLED"]!r}; this release would turn it off.',
            )
        )
    # backend/retention.py: retention_enabled.
    if env.get('RETENTION_ENABLED', '').lower() == 'true' and RETENTION != 'on':
        found.append(
            (
                'RETENTION_ENABLED',
                'DEFAULT_RETENTION',
                f'RETENTION_ENABLED: serving {env["RETENTION_ENABLED"]!r}, repository baseline '
                f'{want["RETENTION_ENABLED"]!r}; this release would turn it off.',
            )
        )
    dropped = enabled_ai_features(env.get('AI_FEATURES', '')) - enabled_ai_features(AI_FEATURES)
    if dropped:
        found.append(
            (
                'AI_FEATURES',
                'DEFAULT_AI_FEATURES',
                f'AI_FEATURES: serving {env["AI_FEATURES"]!r}, repository baseline {AI_FEATURES!r}; '
                f'this release would turn off {", ".join(sorted(dropped))}.',
            )
        )
    return found


def baseline_refusal(reductions, confirm_how):
    settings = ', '.join(setting for setting, _, _ in reductions)
    constants = ' and '.join(constant for _, constant, _ in reductions)
    return '\n'.join(
        [
            f'Refusing a baseline less permissive than the serving revision: {settings}. '
            'Nothing was staged.',
            *(line for _, _, line in reductions),
            f'Historically, keeping it on required changing {constants} in scripts/deploy_backend.py '
            f'in a reviewed pull request. Turning it off required {confirm_how}',
        ]
    )


def note_lowered(record, reductions):
    if reductions:
        warn(
            record,
            'Baseline warning',
            'Lowered on purpose with --confirm-baseline: '
            + ' '.join(line for _, _, line in reductions),
        )


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
            f'Serving commit {serving_commit[:12]} is not in this checkout. The CLI does not proceed; this was historically a by-hand release.'
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
            f'Serving commit {serving_commit[:12]} is not an ancestor of {commit[:12]}. The CLI does not proceed; this was historically a by-hand release.'
        )
    # No rename detection, so a file moved out of a legacy directory still shows its old path.
    names = git(
        runner, 'diff', '--name-only', '--no-renames', f'{serving_commit}..{commit}'
    ).stdout.split()
    return names


def check_hand_released(names):
    changed = [name for name in HAND_RELEASED if name in names]
    if changed:
        raise Refused(
            f'{", ".join(changed)} changed since the serving commit. '
            'The release CLI never handled Firestore rules and indexes: historically they were '
            'changed by hand (docs/firebase-isolation.md, Deployment) before the commit was released. '
            'The CLI does not proceed.'
        )


def check_ttls(runner):
    result = runner.run([sys.executable, 'scripts/ensure_firestore_ttls.py'], check=False)
    if result.returncode:
        raise Refused(
            'The read-only Firestore TTL check failed:\n'
            'Historical diagnostic output for the retired project, which is never deployed to or changed:\n'
            + (result.stdout or '')
            + (result.stderr or '')
            + '\nHistorically a missing policy was enabled by hand with scripts/ensure_firestore_ttls.py --apply.'
        )


def staged_checks(runner, url, commit, version):
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
            and health.get('version') == version
        ):
            break
        if attempt == 5:
            failures.append(
                f'/api/health answered {status} {body[:200]!r}; wanted healthy, schema 3, {commit}, '
                f'version {version}'
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


def publish_release(runner, record, version, commit):
    """Create the immutable version tag and GitHub Release; a tag elsewhere is never moved."""
    remote = git(runner, 'ls-remote', '--tags', 'origin', f'refs/tags/{version}').stdout.split()
    remote_commit = remote[0] if remote else ''
    existing = git(
        runner, 'rev-parse', '-q', '--verify', f'refs/tags/{version}^{{commit}}', check=False
    )
    local_commit = (existing.stdout or '').strip() if existing.returncode == 0 else ''
    for tagged_commit in (remote_commit, local_commit):
        if tagged_commit and tagged_commit != commit:
            raise Refused(
                f'Version tag {version} already points to {tagged_commit[:12]}; '
                f'refusing to move it to {commit[:12]}.'
            )
    if local_commit:
        record.note(f'Version tag {version} already points to {commit[:12]}.')
    else:
        git(runner, 'tag', version, commit)
        record.note(f'Created git tag {version} at {commit[:12]}.')
    if not remote_commit:
        git(runner, 'push', 'origin', f'refs/tags/{version}')
    view = runner.run(['gh', 'release', 'view', version], check=False)
    if view.returncode == 0:
        record.set('GitHub Release', f'`{version}` (existing)')
        record.note(f'GitHub Release {version} already exists.')
        return
    notes = release_notes(runner, commit)
    runner.run(
        ['gh', 'release', 'create', version, '--verify-tag', '--title', version, '--notes', notes]
    )
    record.set('GitHub Release', f'`{version}`')
    record.note(f'Published GitHub Release {version}.')


def publish_live_version(runner, record, commit):
    """Publish the version the live backend reports for commit; this never chooses a number."""
    if git(runner, 'rev-parse', 'HEAD').stdout.strip() != commit:
        raise Refused('The checkout is not the commit to publish.')
    if git(runner, 'merge-base', '--is-ancestor', commit, 'origin/master', check=False).returncode:
        raise Refused(f'{commit} is not on master; only master commits are released.')
    url = service_state(runner).get('status', {}).get('url', '').rstrip('/')
    status, body = runner.fetch(url + '/api/health')
    if status != 200:
        raise Refused(f'Live /api/health answered {status}; nothing was published.')
    try:
        health = json.loads(body)
    except ValueError:
        raise Refused('Live /api/health was not JSON; nothing was published.') from None
    if health.get('source_commit') != commit:
        raise Skipped(f'{commit[:12]} is not what is serving; nothing to publish.')
    version = health.get('version')
    if not valid_version(version):
        warning = (
            f'{commit[:12]} is serving but reports version {version!r}, so no tag or GitHub Release '
            'was created. Historically, redeploying with --version assigned a version number.'
        )
        print(f'::warning::{warning}', file=sys.stderr)
        raise Skipped(warning)
    record.set('Source commit', f'`{commit}`')
    record.set('Release version', f'`{version}`')
    publish_release(runner, record, version, commit)


def firestore_migrations(runner):
    """Applied migrations from Firestore _migrations, or None when the list cannot be fully read."""
    token = runner.run([runner.gcloud, 'auth', 'print-access-token']).stdout.strip()
    status, body = runner.fetch(
        f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/_migrations?pageSize=300',
        headers={'Authorization': 'Bearer ' + token, 'x-goog-user-project': PROJECT},
    )
    if status != 200:
        return None
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    if payload.get('nextPageToken'):
        return None
    items = []
    for doc in payload.get('documents') or []:
        fields = doc.get('fields') or {}
        items.append(
            {
                'migration_id': doc['name'].rsplit('/', 1)[-1],
                'applied_at': (fields.get('applied_at') or {}).get('timestampValue', ''),
                'source_commit': (fields.get('source_commit') or {}).get('stringValue', 'unknown'),
            }
        )
    return items


def warn(record, fact, warning):
    print(f'::warning::{warning}', file=sys.stderr)
    record.set(fact, warning)
    record.note('WARNING: ' + warning)


def check_rollback_rules(record, names, target_commit, version):
    """Return the warning when rules or indexes differ between the target and what is serving."""
    changed = [name for name in HAND_RELEASED if name in names]
    if not changed:
        return None
    warning = (
        f'{", ".join(changed)} changed between target version {version} ({target_commit[:12]}) and '
        'what is serving. A rollback does not roll back rules or indexes; they stay at the newer '
        'hand-released version.'
    )
    warn(record, 'Rules and indexes warning', warning)
    return warning


def check_rollback_migrations(runner, record, target_commit, version):
    """Return the warning when the target is older than a migration, or that cannot be ruled out."""
    ledger = firestore_migrations(runner)
    warning = None
    if ledger is None:
        warning = (
            f'Could not read the Firestore _migrations ledger, so the migration check for version '
            f'{version} ({target_commit[:12]}) was not completed. The target may be older than an '
            'applied data migration, and code rollback does not undo database/data changes.'
        )
    else:
        newer = []
        for entry in sorted(ledger, key=lambda item: item['migration_id']):
            mig_commit = entry['source_commit'].removesuffix('-dirty')
            if (
                not COMMIT.fullmatch(mig_commit)
                or git(
                    runner, 'merge-base', '--is-ancestor', mig_commit, target_commit, check=False
                ).returncode
            ):
                newer.append(
                    f'{entry["migration_id"]} (applied {entry["applied_at"] or "unknown date"} '
                    f'at {mig_commit[:12]})'
                )
        if newer:
            warning = (
                f'Target version {version} ({target_commit[:12]}) is older than applied data '
                f'migration(s): {", ".join(newer)}. Code rollback does not undo database/data changes.'
            )
    if warning:
        warn(record, 'Migration warning', warning)
        return warning
    record.set('Migration check', 'no applied migrations newer than target version')
    record.note('Migration check passed: target version is not older than any applied migration.')
    return None


def resolve_rollback_version(runner, version):
    """Resolve a YYYY.MM.DD-N release tag to its commit on master."""
    if not valid_version(version):
        raise Refused(
            f'Version {version!r} is not a valid YYYY.MM.DD-N release version (for example 2026.11.02-1).'
        )
    resolved = git(
        runner, 'rev-parse', '-q', '--verify', f'refs/tags/{version}^{{commit}}', check=False
    )
    commit = (resolved.stdout or '').strip() if resolved.returncode == 0 else ''
    if not COMMIT.fullmatch(commit):
        raise Refused(
            f'Release version tag {version!r} is not in this checkout. Run git fetch --tags if it is new.'
        )
    if git(runner, 'merge-base', '--is-ancestor', commit, 'origin/master', check=False).returncode:
        raise Refused(f'Release version {version} ({commit[:12]}) is not on master.')
    return commit


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
    record.set(
        'Rollback (historical procedure)',
        'completed' if not problems else 'FAILED, the old app was not restored',
    )
    return problems


def _deploy_backend_and_hosting(
    runner, record, commit, tag, version, previous, serving_summary, staff_emails
):
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
            '--retention',
            RETENTION,
            '--staff-emails',
            staff_emails,
            '--version',
            version,
            '--tag',
            tag,
            '--yes',
        ],
        capture=False,
    )
    staged_service = service_state(runner)
    url, staged_name = tagged_url(staged_service, tag)
    record.set('Backend revision (tag)', f'`{staged_name}` (tag `{tag}`)')
    if staged_name == previous:
        raise Refused('Staging produced no new revision.')
    staged = spec_summary(revision_state(runner, staged_name), staged_service)
    differences = spec_differences(serving_summary, staged)
    if differences:
        raise Refused(
            'The staged revision does not preserve the serving revision; nothing was promoted:\n'
            + '\n'.join(differences)
        )
    for line in baseline_notes(serving_summary, staged):
        record.note('Baseline change: ' + line)
    staged_checks(runner, url, commit, version=version)
    record.set(
        'Staged checks',
        f'passed at {url}: health (schema 3, version {version}, source commit), signed-out 401s, TTL policies',
    )
    record.note(f'Staged {staged_name} at 0% and its checks passed.')

    hosting_deployed = False
    try:
        promote(runner, tag)
        record.set('Backend traffic', '100% (promoted)')
        record.note(f'Promoted {staged_name} to 100%.')
        runner.run(
            [sys.executable, 'scripts/stamp_hosting.py', '--version', version], capture=False
        )
        hosting_deployed = True
        firebase(runner, 'deploy', '--only', HOSTING_TARGET)
        hosting_after = hosting_release(runner)
        if hosting_after['release'] == hosting_before['release']:
            hosting_deployed = False
            raise Refused('Hosting deploy created no new release.')
        record.set(
            'Frontend (Hosting)',
            f'`{commit}` (version `{version}`, Hosting version `{hosting_after["version"]}`, release `{hosting_after["release"]}`)',
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


def release(runner, record, commit, tag, check_only=False, confirm_baseline=False):
    service = service_state(runner)
    previous = serving_revision(service)
    serving = revision_state(runner, previous)
    serving_commit = revision_commit(serving)
    record.set('Source commit', f'`{commit}`')
    record.set('Rollback pair (serving before)', f'backend `{previous}` at `{serving_commit}`')
    names = check_candidate(runner, commit, serving_commit)
    check_hand_released(names)
    reason = legacy_skip_reason(names, serving_commit, commit)
    if reason:
        if not check_only:
            raise Skipped(reason)
        record.note(f'Check only: a real run would skip. {reason}')
    check_ttls(runner)
    serving_summary = spec_summary(serving, service)
    staff_emails = serving_staff_emails(serving_summary)
    reductions = baseline_reductions(serving_summary)
    if reductions and not confirm_baseline:
        raise Refused(
            baseline_refusal(
                reductions,
                f'owner confirmation with --confirm-baseline on '
                f'scripts/auto_deploy.py --commit {commit}.',
            )
        )
    note_lowered(record, reductions)
    version = next_version(runner, commit)
    record.set('Release version', f'`{version}`')
    record.note(
        'Candidate is newer than the serving commit; no rules or indexes changed; TTL policies in place.'
    )
    record.note('The serving STAFF_EMAILS is set and is carried explicitly to the staged revision.')
    if check_only:
        record.note(f'Check only (candidate version {version}): nothing staged or deployed.')
        return
    _deploy_backend_and_hosting(
        runner, record, commit, tag, version, previous, serving_summary, staff_emails
    )


def rollback_to_version(
    runner,
    record,
    version,
    tag=None,
    run_id='',
    confirm_past_migration=False,
    confirm_baseline=False,
):
    target_commit = resolve_rollback_version(runner, version)
    tag = check_tag(tag) if tag else default_tag(target_commit, run_id)
    service = service_state(runner)
    previous = serving_revision(service)
    serving = revision_state(runner, previous)
    serving_commit = revision_commit(serving)
    record.set('Rollback target version', f'`{version}`')
    record.set('Release version', f'`{version}`')
    record.set('Source commit', f'`{target_commit}`')
    record.set('Rollback pair (serving before)', f'backend `{previous}` at `{serving_commit}`')
    if serving_commit == target_commit:
        raise Skipped(f'Version {version} ({target_commit[:12]}) is already serving.')
    if git(runner, 'cat-file', '-e', serving_commit + '^{commit}', check=False).returncode:
        raise Refused(
            f'Serving commit {serving_commit[:12]} is not in this checkout. The CLI does not proceed; this was historically a by-hand release.'
        )
    names = git(runner, 'diff', '--name-only', f'{target_commit}..{serving_commit}').stdout.split()
    check_ttls(runner)
    serving_summary = spec_summary(serving, service)
    staff_emails = serving_staff_emails(serving_summary)
    rules_warning = check_rollback_rules(record, names, target_commit, version)
    migration_warning = check_rollback_migrations(runner, record, target_commit, version)
    reductions = baseline_reductions(serving_summary)
    refusals = []
    if reductions and not confirm_baseline:
        refusals.append(baseline_refusal(reductions, 'confirmation with --confirm-baseline.'))
    if (rules_warning or migration_warning) and not confirm_past_migration:
        refusals.append(
            f'Rollback to {version} stopped; nothing was staged. Historically it was confirmed with '
            '--confirm-past-migration.'
        )
    if refusals:
        raise Refused('\n'.join(refusals))
    note_lowered(record, reductions)
    record.note(
        f'Rollback target {version} ({target_commit[:12]}) verified; TTL policies in place.'
    )
    record.note('The serving STAFF_EMAILS is set and is carried explicitly to the staged revision.')
    head = git(runner, 'rev-parse', 'HEAD').stdout.strip()
    original = (
        git(runner, 'symbolic-ref', '-q', '--short', 'HEAD', check=False).stdout or ''
    ).strip()
    moved = head != target_commit
    if moved:
        git(runner, 'checkout', '--detach', target_commit)
    try:
        _deploy_backend_and_hosting(
            runner, record, target_commit, tag, version, previous, serving_summary, staff_emails
        )
    finally:
        if moved and git(runner, 'checkout', original or head, check=False).returncode:
            record.note(f'Could not return this checkout to {original or head}; it is still on the target commit.')
    record.note(f'Rolled production back to version {version} ({target_commit[:12]}).')
    record.note('Historically the bad change had to be fixed or reverted before the next manual release.')


def main(argv=None, runner=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--commit', help='CI-tested checkout used for a legacy release')
    target.add_argument(
        '--publish',
        metavar='COMMIT',
        help='published the tag and GitHub Release for the version the old backend reported for COMMIT',
    )
    target.add_argument(
        '--next-version',
        action='store_true',
        help='printed the version number for a legacy hand release of HEAD after fetching tags',
    )
    target.add_argument(
        '--rollback',
        metavar='VERSION',
        help='rolled the old app back to an existing YYYY.MM.DD-N release tag',
    )
    parser.add_argument('--tag', help='revision URL tag (default: a<commit prefix>-<run id>)')
    parser.add_argument('--run-id', default='', help='CI run id, folded into the default tag')
    parser.add_argument(
        '--check-only',
        action='store_true',
        help='with --commit: ran every refusal check without staging or deploying',
    )
    parser.add_argument(
        '--confirm-past-migration',
        action='store_true',
        help='let --rollback continue past a data migration or a rules or index change in the old app',
    )
    parser.add_argument(
        '--confirm-baseline',
        action='store_true',
        help=(
            'with --commit or --rollback: allowed staging a baseline that turned off '
            'a feature enabled on the serving revision'
        ),
    )
    args = parser.parse_args(argv)
    if args.check_only and not args.commit:
        print('--check-only works only with --commit.', file=sys.stderr)
        return 2
    if args.confirm_baseline and not (args.commit or args.rollback):
        print('--confirm-baseline works only with --commit or --rollback.', file=sys.stderr)
        return 2
    commit = args.commit or args.publish
    if commit and not COMMIT.fullmatch(commit):
        print('--commit and --publish need a full lowercase commit hash.', file=sys.stderr)
        return 2
    if args.rollback and not valid_version(args.rollback):
        print(
            '--rollback must be a date-style version YYYY.MM.DD-N (for example 2026.11.02-1).',
            file=sys.stderr,
        )
        return 2
    try:
        if args.commit:
            tag = check_tag(args.tag) if args.tag else default_tag(args.commit, args.run_id)
        else:
            tag = check_tag(args.tag) if args.tag else None
    except Refused as error:
        print(str(error), file=sys.stderr)
        return 2
    runner = runner or Runner()
    if args.next_version:
        try:
            git(runner, 'fetch', '--tags', '--quiet')
            print(next_version(runner, git(runner, 'rev-parse', 'HEAD').stdout.strip()))
            return 0
        except Refused as error:
            print(str(error), file=sys.stderr)
            return 1
    record = Record(os.environ.get('GITHUB_STEP_SUMMARY'))
    heading = '## Production rollback\n\n' if args.rollback else '## Production release\n\n'
    record.append(heading)
    outcome = 'FAILED'
    try:
        if args.rollback:
            rollback_to_version(
                runner,
                record,
                args.rollback,
                tag=tag,
                run_id=args.run_id,
                confirm_past_migration=args.confirm_past_migration,
                confirm_baseline=args.confirm_baseline,
            )
            outcome = f'rolled back to {args.rollback}'
        elif args.publish:
            publish_live_version(runner, record, args.publish)
            outcome = 'published'
        else:
            release(runner, record, args.commit, tag, args.check_only, args.confirm_baseline)
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
