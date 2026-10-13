"""Read-only, credential-free record of the dedicated backend/Hosting release pair."""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.verify_live_release import access_token, PROJECT
from scripts.verify_common import EVIDENCE, gcloud

SERVICE = 'alert-disaster-field-estimator'
environment = dict(os.environ)
environment.pop('PYTHONPATH', None)
result = subprocess.run(
    [
        gcloud(),
        'run',
        'services',
        'describe',
        SERVICE,
        '--project=' + PROJECT,
        '--region=us-west2',
        '--format=json(status.traffic,status.latestReadyRevisionName)',
    ],
    env=environment,
    capture_output=True,
    text=True,
)
if result.returncode:
    raise RuntimeError('Dedicated backend state lookup failed; credentials were not logged.')
backend = json.loads(result.stdout)['status']
response = requests.get(
    f'https://firebasehosting.googleapis.com/v1beta1/sites/{PROJECT}/channels/live/releases?pageSize=1',
    headers={'Authorization': 'Bearer ' + access_token(), 'x-goog-user-project': PROJECT},
    timeout=30,
)
if response.status_code != 200:
    raise RuntimeError('Dedicated Hosting release lookup failed: ' + str(response.status_code))
release = response.json()['releases'][0]
state = {
    'checked_at_utc': datetime.now(timezone.utc).isoformat(),
    'project': PROJECT,
    'backend': backend,
    'hosting': {
        'release': release['name'],
        'version': release['version']['name'],
        'released_at': release.get('releaseTime'),
    },
}
phase = sys.argv[1] if len(sys.argv) > 1 else 'observed'
if phase not in ('before', 'after', 'observed'):
    raise RuntimeError('Expected before, after or observed.')
target = EVIDENCE / 'live-release-20261007' / ('cutover-' + phase + '.json')
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(state, indent=2) + '\n', encoding='utf8')
print(json.dumps(state, indent=2))
