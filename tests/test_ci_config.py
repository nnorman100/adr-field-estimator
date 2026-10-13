"""CI configuration guards: Python version source and deny-all Firestore rules."""

import json
import re
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from ci_python_version import python_version  # noqa: E402


def test_ci_python_version_matches_dockerfile():
    assert re.fullmatch(r'\d+\.\d+', python_version())


@pytest.mark.parametrize(
    'line,expected',
    [
        ('FROM python:3.11-slim@sha256:abc', '3.11'),
        ('FROM python:3.14-slim', '3.14'),
        ('FROM python:3.12.4-slim-bookworm', '3.12'),
        ('FROM --platform=linux/amd64 python:3.13-slim', '3.13'),
    ],
)
def test_python_version_parses_base_image_forms(tmp_path, line, expected):
    dockerfile = tmp_path / 'Dockerfile'
    dockerfile.write_text(f'{line}\nWORKDIR /app\n')
    assert python_version(dockerfile) == expected


@pytest.mark.parametrize(
    'content',
    [
        '',
        'FROM debian:12\n',
        'FROM python:latest\n',
        'FROM python:3.11-slim\nFROM python:3.12-slim\n',
    ],
)
def test_python_version_fails_when_unparseable(tmp_path, content):
    dockerfile = tmp_path / 'Dockerfile'
    dockerfile.write_text(content)
    with pytest.raises(ValueError):
        python_version(dockerfile)


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', text)


def test_firebase_json_points_at_rules_file():
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['firestore']['rules'] == 'firestore.rules'
    assert (ROOT / 'firestore.rules').is_file()


def test_firestore_rules_deny_all_client_access():
    """Structural check; all data access must go through the backend's service account."""
    rules = strip_comments((ROOT / 'firestore.rules').read_text())
    assert re.findall(r'\bmatch\s+(/\S+)\s*\{', rules) == [
        '/databases/{database}/documents',
        '/{document=**}',
    ]
    allows = re.findall(r'\ballow\s+([^:;]+?)\s*(?::\s*if\s+([^;]+?))?\s*;', rules)
    assert allows, 'rules must explicitly deny'
    for methods, condition in allows:
        assert condition == 'false', f'allow {methods} must be unconditionally false'
    assert {m.strip() for methods, _ in allows for m in methods.split(',')} == {'read', 'write'}
    assert len(re.findall(r'\ballow\b', rules)) == len(allows)
    assert 'function' not in rules and 'request.auth' not in rules
