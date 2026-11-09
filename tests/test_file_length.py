"""The 1,000-line single-file limit: new over-limit files fail, allowlisted ones only warn."""

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'check_file_length', ROOT / 'scripts' / 'check_file_length.py'
)
check_file_length = importlib.util.module_from_spec(spec)
sys.modules['check_file_length'] = check_file_length
spec.loader.exec_module(check_file_length)


def write(root, name, lines):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('x = 1\n' * lines, encoding='utf-8')


def test_new_over_limit_python_file_fails(tmp_path):
    write(tmp_path, 'backend/new_module.py', 1001)
    errors, warnings, stale = check_file_length.check(tmp_path, limit=1000, allowlist=set())
    assert len(errors) == 1 and 'backend/new_module.py' in errors[0]
    assert warnings == [] and stale == []


def test_file_at_the_limit_passes(tmp_path):
    write(tmp_path, 'backend/at_limit.py', 1000)
    assert check_file_length.check(tmp_path, limit=1000, allowlist=set()) == ([], [], [])


def test_allowlisted_file_only_warns(tmp_path):
    write(tmp_path, 'backend/old_module.py', 1500)
    errors, warnings, stale = check_file_length.check(
        tmp_path, limit=1000, allowlist={'backend/old_module.py'}
    )
    assert errors == [] and stale == []
    assert len(warnings) == 1 and '1500 lines' in warnings[0]


def test_allowlisted_file_under_the_limit_is_reported(tmp_path):
    write(tmp_path, 'backend/old_module.py', 900)
    write(tmp_path, 'public/old.js', 1000)
    errors, warnings, stale = check_file_length.check(
        tmp_path,
        limit=1000,
        allowlist={'backend/old_module.py', 'public/old.js', 'backend/gone.py'},
    )
    assert errors == [] and warnings == []
    assert len(stale) == 3
    assert any('backend/old_module.py' in m and '900' in m for m in stale)
    assert any('public/old.js' in m for m in stale)
    assert any('backend/gone.py' in m and 'no longer exists' in m for m in stale)


def test_vendored_files_and_javascript_are_not_failed_here(tmp_path):
    write(tmp_path, 'public/vendor/lib/big.py', 2000)
    write(tmp_path, 'public/big.js', 2000)  # ESLint max-lines covers JavaScript
    assert check_file_length.check(tmp_path, limit=1000, allowlist=set()) == ([], [], [])


def test_line_count_matches_eslint():
    count = check_file_length.count_lines
    assert count('') == 0
    assert count('a\n') == 1
    assert count('a') == 1
    assert count('a\n\nb\n') == 3
    assert count('a\r\nb\r\n') == 2


def test_repository_is_clean_today():
    errors, _warnings, stale = check_file_length.check()
    assert errors == []
    assert stale == []


def test_allowlist_has_no_unknown_shape():
    data = json.loads((ROOT / 'scripts' / 'file_length_allowlist.json').read_text(encoding='utf-8'))
    assert data['limit'] == 1000
    assert data['files'] == sorted(set(data['files']))


def test_over_limit_web_typescript_file_fails(tmp_path):
    for name in ('web/src/big.ts', 'web/src/big.tsx', 'web/next.config.mts'):
        write(tmp_path, name, 1001)
    errors, _, _ = check_file_length.check(tmp_path, limit=1000, allowlist=set())
    assert len(errors) == 3
    for name in ('web/src/big.ts', 'web/src/big.tsx', 'web/next.config.mts'):
        assert any(name in m for m in errors)


def test_over_limit_web_javascript_and_config_files_fail(tmp_path):
    for name in ('web/eslint.config.mjs', 'web/tsconfig.json', 'web/env.example'):
        write(tmp_path, name, 1001)
    errors, _, _ = check_file_length.check(tmp_path, limit=1000, allowlist=set())
    assert len(errors) == 3


def test_web_lockfile_and_non_web_json_are_not_counted(tmp_path):
    write(tmp_path, 'web/package-lock.json', 5000)
    write(tmp_path, 'web/node_modules/pkg/index.ts', 5000)
    write(tmp_path, 'package-lock.json', 5000)
    write(tmp_path, 'docs/data.json', 5000)
    assert check_file_length.check(tmp_path, limit=1000, allowlist=set()) == ([], [], [])


def test_web_files_at_the_limit_pass(tmp_path):
    write(tmp_path, 'web/src/at_limit.ts', 1000)
    assert check_file_length.check(tmp_path, limit=1000, allowlist=set()) == ([], [], [])
