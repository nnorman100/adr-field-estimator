"""Stage a dedicated backend revision with an explicit feature baseline and no traffic.

Cloud Run copies environment variables from the service's latest template, which can be a staged
revision that never received traffic. Setting WORKSPACES_ENABLED, AI_FEATURES and
PRICE_BOOKS_ENABLED on every deploy prevents a release from silently inheriting those staged values.
The defaults are the current production baseline: AI_FEATURES=readiness and price books off. Pass
--ai-features or --price-books only to change that baseline on purpose. STAFF_EMAILS is the legacy
staff allowlist and fails closed: the backend treats an unset value as nobody being staff. Pass
--staff-emails to set it; without it the revision inherits the service template's value, and the
script refuses (even for --dry-run) when that template has none. The same command mounts the
Maps key secret by name, so a release never depends on a binding made by hand in the console.
Promotion is a separate reviewed update-traffic step.

The deployed commit is written to backend/SOURCE_COMMIT inside the uploaded build context, so the
image itself reports it as source_commit in /api/health; a later raw deploy cannot inherit it the way
it inherits environment variables. The same commit is set as the revision's source-commit label.
--version adds the release version to that file, and the image reports it as version in /api/health.
"""

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.release_stamp import DirtyTree, release_row, release_version, source_commit

PROJECT = 'alert-disaster-field-2026'
# The Maps key for address suggestions and the job map: a Secret Manager secret that adr-runtime may
# read, mounted as an environment variable. Without it the app keeps a plain address box.
MAPS_SECRET = 'MAPS_API_KEY=dryscope-maps-api-key:latest'
STAMP = ROOT / 'backend' / 'SOURCE_COMMIT'
# Names the server actually reads. An unknown name would deploy as a silent no-op.
KNOWN_AI_FEATURES = frozenset(
    {'readiness', 'drying_watch', 'priced_extras', 'job_summary', 'ai_usage', 'estimate_assist'}
)
DEFAULT_AI_FEATURES = 'readiness'
_ON_OFF = {'on': 'true', 'off': 'false'}


def ai_features_value(value):
    """Normalize a deliberate AI_FEATURES list. 'none' or 'off' sets an empty list."""
    text = value.strip().lower()
    if text in ('none', 'off'):
        return ''
    names = []
    known = ', '.join(sorted(KNOWN_AI_FEATURES))
    for part in text.split(','):
        name = part.strip()
        if not name:
            raise argparse.ArgumentTypeError(f'empty AI feature name; choose from {known}, or none')
        if name not in KNOWN_AI_FEATURES:
            raise argparse.ArgumentTypeError(
                f'unknown AI feature {name!r}; choose from {known}, or none'
            )
        if name not in names:
            names.append(name)
    return ','.join(names)


def env_assignments(workspaces, ai_features, price_books):
    return {
        'WORKSPACES_ENABLED': _ON_OFF[workspaces],
        'AI_FEATURES': ai_features,
        'PRICE_BOOKS_ENABLED': _ON_OFF[price_books],
    }


def staff_emails_value(value):
    """Normalize a deliberate STAFF_EMAILS list: comma-separated, lowercase, no blanks or repeats."""
    names = []
    for part in value.split(','):
        email = part.strip().lower()
        if not email:
            continue
        if not re.fullmatch(r'[^@\s,^|]+@[^@\s,^|]+\.[^@\s,^|]+', email):
            raise argparse.ArgumentTypeError(f'{email!r} is not an email address')
        if email not in names:
            names.append(email)
    if not names:
        raise argparse.ArgumentTypeError('give at least one email address')
    return ','.join(names)


def update_env_flag(assignments):
    # A caret delimiter keeps a comma inside AI_FEATURES or STAFF_EMAILS from splitting the flag.
    payload = '|'.join(f'{key}={value}' for key, value in assignments.items())
    return '--update-env-vars=^|^' + payload


def baseline_line(assignments):
    parts = []
    for key, value in assignments.items():
        parts.append(key + '=' + (value or "''"))
    return 'Feature baseline: ' + ' '.join(parts)


def command(
    workspaces, tag, commit, ai_features=DEFAULT_AI_FEATURES, price_books='off', staff_emails=None
):
    assignments = env_assignments(workspaces, ai_features, price_books)
    if staff_emails:
        assignments['STAFF_EMAILS'] = staff_emails
    return [
        'gcloud',
        'run',
        'deploy',
        'alert-disaster-field-estimator',
        '--source=./backend',
        '--region=us-west2',
        '--project=' + PROJECT,
        '--billing-project=' + PROJECT,
        f'--service-account=adr-runtime@{PROJECT}.iam.gserviceaccount.com',
        f'--build-service-account=projects/{PROJECT}/serviceAccounts/adr-builder@{PROJECT}.iam.gserviceaccount.com',
        '--max-instances=2',
        '--concurrency=20',
        '--cpu=1',
        '--memory=1Gi',
        '--timeout=3600',
        '--allow-unauthenticated',
        update_env_flag(assignments),
        '--update-secrets=' + MAPS_SECRET,
        '--update-labels=source-commit=' + commit,
        '--no-traffic',
        '--tag=' + tag,
    ]


def describe_service(argv):
    return subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)


def template_staff_emails(describe):
    """STAFF_EMAILS a deploy without --staff-emails inherits; empty when unset or unreadable."""
    try:
        result = describe(
            [
                shutil.which('gcloud') or 'gcloud',
                'run',
                'services',
                'describe',
                'alert-disaster-field-estimator',
                '--region=us-west2',
                '--project=' + PROJECT,
                '--format=json',
            ]
        )
    except OSError:
        return ''
    if result.returncode != 0:
        return ''
    try:
        containers = json.loads(result.stdout)['spec']['template']['spec']['containers']
        env = containers[0].get('env') or []
    except (ValueError, KeyError, IndexError, TypeError):
        return ''
    for item in env:
        if item.get('name') == 'STAFF_EMAILS':
            return (item.get('value') or '').strip(' ,')
    return ''


def revision_tag(value):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,45}', value):
        raise argparse.ArgumentTypeError(
            'use lowercase letters, digits and hyphens, starting with a letter'
        )
    return value


def main(argv=None, run=subprocess.run, git=subprocess.run, describe=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--workspaces', choices=('on', 'off'), required=True)
    parser.add_argument(
        '--ai-features',
        type=ai_features_value,
        default=DEFAULT_AI_FEATURES,
        help=(
            'comma-separated AI_FEATURES to set on this revision '
            f'(default: {DEFAULT_AI_FEATURES}; none turns every AI feature off)'
        ),
    )
    parser.add_argument(
        '--price-books',
        choices=('on', 'off'),
        default='off',
        help='PRICE_BOOKS_ENABLED for this revision (default: off)',
    )
    parser.add_argument(
        '--staff-emails',
        type=staff_emails_value,
        default=None,
        help=(
            'STAFF_EMAILS for this revision (comma-separated). Without it the revision inherits '
            "the service template's value; the deploy is refused when that template has none"
        ),
    )
    parser.add_argument(
        '--tag',
        type=revision_tag,
        required=True,
        help='revision URL tag, for example workspaces-off-20261010',
    )
    parser.add_argument(
        '--version',
        type=release_version,
        default=None,
        help='date-style release version to stamp into /api/health, for example 2026.11.02-1',
    )
    parser.add_argument(
        '--dry-run', action='store_true', help='print the gcloud command without running it'
    )
    parser.add_argument('--yes', action='store_true', help='confirm the deploy')
    parser.add_argument(
        '--allow-dirty',
        action='store_true',
        help='deploy uncommitted backend changes, stamped <commit>-dirty instead of refusing',
    )
    args = parser.parse_args(argv)
    try:
        commit = source_commit(['backend'], args.allow_dirty, git)
    except DirtyTree as error:
        print(
            f'Refusing to stamp the backend: {error}\nCommit first, or pass --allow-dirty to mark the release dirty.',
            file=sys.stderr,
        )
        return 2
    if args.version and commit.endswith('-dirty'):
        print(
            'Refusing to stamp the backend: --version needs a clean tree. Commit first, or drop '
            '--version so the dirty build shows its commit.',
            file=sys.stderr,
        )
        return 2
    if not args.staff_emails and not template_staff_emails(describe or describe_service):
        print(
            'Refusing to deploy: the Cloud Run service template has no STAFF_EMAILS (or could not '
            'be read), so this revision would admit nobody in workspaces-off mode. '
            'Pass --staff-emails.',
            file=sys.stderr,
        )
        return 2
    assignments = env_assignments(args.workspaces, args.ai_features, args.price_books)
    argv = command(
        args.workspaces, args.tag, commit, args.ai_features, args.price_books, args.staff_emails
    )
    print(baseline_line(assignments))
    if args.staff_emails:
        print('STAFF_EMAILS: set explicitly on this revision.')
    if args.version:
        print(f'Release version: {args.version}')
    if args.dry_run:
        print(shlex.join(argv))
        return 0
    if not args.yes:
        print(
            'Refusing to deploy without --yes. Review the command with --dry-run first.',
            file=sys.stderr,
        )
        return 2
    stamp_body = f'{commit}\n{args.version}\n' if args.version else commit + '\n'
    STAMP.write_text(stamp_body, encoding='utf8')
    try:
        code = run([shutil.which('gcloud') or 'gcloud', *argv[1:]], cwd=ROOT).returncode
    finally:
        STAMP.unlink(missing_ok=True)
    if code == 0:
        notes = (
            f'workspaces {args.workspaces}; '
            f'AI_FEATURES={args.ai_features or "(none)"}; '
            f'price books {args.price_books}'
        )
        if args.version:
            notes += f'; version {args.version}'
        print(
            'Append to RELEASES.md, replacing REVISION with the revision suffix printed above (for example 00017-kap):\n'
            + release_row(
                backend=f'`REVISION` (tag `{args.tag}`)',
                commit=commit,
                traffic='0% (staged)',
                notes=notes,
            )
        )
    return code


if __name__ == '__main__':
    sys.exit(main())
