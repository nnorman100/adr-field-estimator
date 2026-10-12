"""Print the Python minor version of the backend container's base image.

backend/Dockerfile is the single source of truth: CI jobs that install the
backend requirements run on this version, so a base-image bump (for example a
Dependabot pull request) is tested on the new version automatically.
"""
import re
import sys
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / 'backend' / 'Dockerfile'
FROM_PYTHON = re.compile(r'^FROM\s+(?:--platform=\S+\s+)?python:(\d+\.\d+)(?:\.\d+)?(?:[-@\s]|$)', re.IGNORECASE)

def python_version(dockerfile=DOCKERFILE):
    versions = []
    for line in Path(dockerfile).read_text(encoding='utf-8').splitlines():
        match = FROM_PYTHON.match(line.strip())
        if match:
            versions.append(match.group(1))
    if len(versions) != 1:
        raise ValueError(f'expected exactly one "FROM python:<major>.<minor>" line in {dockerfile}, found {len(versions)}')
    return versions[0]

if __name__ == '__main__':
    try:
        print(python_version(*sys.argv[1:2]))
    except (OSError, ValueError) as error:
        print(f'::error::Cannot derive the CI Python version: {error}', file=sys.stderr)
        sys.exit(1)
