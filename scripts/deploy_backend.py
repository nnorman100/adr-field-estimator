"""Stage a dedicated backend revision with an explicit workspace flag and no traffic.

Cloud Run copies environment variables from the service's latest template, which can be a staged
revision that never received traffic. Setting WORKSPACES_ENABLED on every deploy prevents a release
from silently inheriting the staged value. Promotion is a separate reviewed update-traffic step.

The deployed commit is written to backend/SOURCE_COMMIT inside the uploaded build context, so the
image itself reports it as source_commit in /api/health; a later raw deploy cannot inherit it the way
it inherits environment variables. The same commit is set as the revision's source-commit label.
"""
import argparse
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.release_stamp import DirtyTree, release_row, source_commit

PROJECT = 'alert-disaster-field-2026'
STAMP = ROOT / 'backend' / 'SOURCE_COMMIT'


def command(workspaces, tag, commit):
    return ['gcloud', 'run', 'deploy', 'alert-disaster-field-estimator', '--source=./backend', '--region=us-west2',
            '--project=' + PROJECT, '--billing-project=' + PROJECT,
            f'--service-account=adr-runtime@{PROJECT}.iam.gserviceaccount.com',
            f'--build-service-account=projects/{PROJECT}/serviceAccounts/adr-builder@{PROJECT}.iam.gserviceaccount.com',
            '--max-instances=2', '--concurrency=20', '--cpu=1', '--memory=1Gi', '--timeout=3600', '--allow-unauthenticated',
            '--update-env-vars=WORKSPACES_ENABLED=' + {'on': 'true', 'off': 'false'}[workspaces],
            '--update-labels=source-commit=' + commit,
            '--no-traffic', '--tag=' + tag]


def revision_tag(value):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,45}', value):
        raise argparse.ArgumentTypeError('use lowercase letters, digits and hyphens, starting with a letter')
    return value


def main(argv=None, run=subprocess.run, git=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--workspaces', choices=('on', 'off'), required=True)
    parser.add_argument('--tag', type=revision_tag, required=True, help='revision URL tag, for example workspaces-off-20261010')
    parser.add_argument('--dry-run', action='store_true', help='print the gcloud command without running it')
    parser.add_argument('--yes', action='store_true', help='confirm the deploy')
    parser.add_argument('--allow-dirty', action='store_true',
                        help='deploy uncommitted backend changes, stamped <commit>-dirty instead of refusing')
    args = parser.parse_args(argv)
    try:
        commit = source_commit(['backend'], args.allow_dirty, git)
    except DirtyTree as error:
        print(f'Refusing to stamp the backend: {error}\nCommit first, or pass --allow-dirty to mark the release dirty.',
              file=sys.stderr)
        return 2
    argv = command(args.workspaces, args.tag, commit)
    if args.dry_run:
        print(shlex.join(argv))
        return 0
    if not args.yes:
        print('Refusing to deploy without --yes. Review the command with --dry-run first.', file=sys.stderr)
        return 2
    STAMP.write_text(commit + '\n', encoding='utf8')
    try:
        code = run([shutil.which('gcloud') or 'gcloud', *argv[1:]], cwd=ROOT).returncode
    finally:
        STAMP.unlink(missing_ok=True)
    if code == 0:
        print('Append to RELEASES.md, replacing REVISION with the revision suffix printed above (for example 00017-kap):\n'
              + release_row(backend=f'`REVISION` (tag `{args.tag}`)', commit=commit,
                            traffic='0% (staged)', notes=f'workspaces {args.workspaces}'))
    return code


if __name__ == '__main__':
    sys.exit(main())
