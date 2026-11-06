"""Coverage for the no-growth ceilings and non-code source files."""

import pytest

from tests.test_file_length import check_file_length, write


@pytest.mark.parametrize('name', ['public/new.css', 'docs/new.md'])
def test_new_stylesheets_and_markdown_obey_the_limit(tmp_path, name):
    write(tmp_path, name, 1000)
    assert check_file_length.check(tmp_path, 1000, set()) == ([], [], [])
    write(tmp_path, name, 1001)
    assert len(check_file_length.check(tmp_path, 1000, set())[0]) == 1


@pytest.mark.parametrize('name', ['public/old.css', 'docs/old.md', 'public/old.js', 'old.py'])
def test_existing_files_cannot_grow_past_their_baseline(tmp_path, name):
    write(tmp_path, name, 1100)
    args = (tmp_path, 1000, {name}, {name: 1100})
    errors, warnings, stale = check_file_length.check(*args)
    assert not errors and len(warnings) == 1 and not stale
    write(tmp_path, name, 1101)
    errors, _, _ = check_file_length.check(*args)
    assert len(errors) == 1 and '1100-line baseline' in errors[0]


def test_generated_and_vendor_files_remain_excluded(tmp_path):
    for name in ['public/vendor/library.md', 'node_modules/pkg/file.css', 'dist/generated.md']:
        write(tmp_path, name, 2000)
    assert check_file_length.check(tmp_path, 1000, set()) == ([], [], [])
