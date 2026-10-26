"""Check, and with --apply enable, the Firestore TTL policies this app relies on.

Each policy is `expire_at` on one collection group of the dedicated project. The default run is
read-only and prints `match` or `missing` per policy, exiting 1 when any is missing, so it can gate
a release. `--apply` enables only the missing ones (an enabled policy is never touched), so a re-run
is a no-op. The project is fixed; there is no project argument.

Application code enforces every expiry on use, so physical deletion only trims records that can no
longer be used. Each field's value is asserted in tests/test_firestore_ttls.py before enabling it.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.verify_common import PROJECT, gcloud

FIELD = 'expire_at'
# What each collection group holds that carries the field; see docs/firebase-isolation.md.
COLLECTION_GROUPS = {
    '_job_insights': 'Regenerable job summary caches; expire 30 days after generation.',
    '_live_resume': 'Live resume checkpoint, 600 s after the last update',
    '_signing_links': 'homeowner signing link: its expiry, then 30 days after signing',
    '_limits': 'per-address anonymous request counter, 1 hour after its last request',
    '_document_links': 'read-only document link: its expiry (30 days)',
}
# A policy in either state is in place; Firestore reports CREATING while it backfills.
PRESENT = {'ACTIVE', 'CREATING'}


def gcloud_json(argv):
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode:
        # gcloud's own message names the problem; it carries no credentials.
        raise RuntimeError(result.stderr.strip() or 'gcloud exited with ' + str(result.returncode))
    return json.loads(result.stdout or '{}')


def states(run=gcloud_json):
    """The TTL state of `expire_at` per collection group: ACTIVE, CREATING or NEEDS_REPAIR.

    `ttls list` returns only fields that have a policy, so a group absent from the result is
    missing."""
    fields = run(
        [
            gcloud(),
            'firestore',
            'fields',
            'ttls',
            'list',
            f'--project={PROJECT}',
            '--format=json',
        ]
    )
    found = {}
    for field in fields:
        match = re.fullmatch(r'.*/collectionGroups/([^/]+)/fields/(.+)', field.get('name', ''))
        if match and match.group(2) == FIELD:
            found[match.group(1)] = (field.get('ttlConfig') or {}).get('state') or 'MISSING'
    return found


def enable(group):
    # --async returns once Firestore accepts the change; the backfill continues server-side.
    subprocess.run(
        [
            gcloud(),
            'firestore',
            'fields',
            'ttls',
            'update',
            FIELD,
            f'--collection-group={group}',
            '--enable-ttl',
            '--async',
            f'--project={PROJECT}',
            '--quiet',
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def ensure(apply=False, run=gcloud_json, enabler=None, out=print):
    """Print one line per policy and return the number still not in place."""
    enabler = enabler or enable
    current = states(run)
    missing = 0
    for group, holds in COLLECTION_GROUPS.items():
        if current.get(group) in PRESENT:
            out(f'match    {group}.{FIELD}  {current[group]}  ({holds})')
        elif not apply:
            missing += 1
            out(f'missing  {group}.{FIELD}  {current.get(group, "MISSING")}  ({holds})')
        else:
            enabler(group)
            after = states(run).get(group, 'MISSING')
            if after in PRESENT:
                out(f'enabled  {group}.{FIELD}  {after}  ({holds})')
            else:
                missing += 1
                out(f'FAILED   {group}.{FIELD}  {after}  ({holds})')
    return missing


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument(
        '--apply',
        action='store_true',
        help='enable the missing policies (default: read-only check)',
    )
    args = parser.parse_args(argv)
    print(f'Firestore TTL policies in {PROJECT} ({"apply" if args.apply else "read-only check"})')
    try:
        missing = ensure(args.apply)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', None) or error
        print(f'Stopped: {str(detail).strip()}', file=sys.stderr)
        return 2
    if missing:
        hint = '' if args.apply else ' Run again with --apply to enable them.'
        print(f'{missing} policy(ies) not in place.{hint}')
        return 1
    print('All TTL policies are in place.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
