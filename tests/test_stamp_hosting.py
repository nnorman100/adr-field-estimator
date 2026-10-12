"""The Hosting shell is released only with a consistent source-commit stamp."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from scripts import stamp_hosting as hosting

ROOT = Path(__file__).resolve().parents[1]
HEAD = 'fedcba9876543210fedcba9876543210fedcba98'


def fake_git(status=''):
    def git(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, stdout={'rev-parse': HEAD + '\n', 'status': status}[argv[1]])
    return git


@pytest.fixture
def shell(tmp_path):
    for name in hosting.TARGETS:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, tmp_path / name)
    return tmp_path


def test_committed_shell_carries_only_the_placeholder():
    for name, rules in hosting.TARGETS.items():
        text = (ROOT / name).read_text(encoding='utf8')
        assert set(hosting.markers(text, rules)) == {hosting.PLACEHOLDER}, name
        assert hosting.stamp(text, rules, hosting.PLACEHOLDER) == text


def test_every_versioned_asset_url_is_stamped():
    # A new ?v= reference outside TARGETS would keep a stale cache key after release.
    for path in [*ROOT.joinpath('public').rglob('*'), ROOT / 'index.html']:
        if path.suffix in ('.html', '.js', '.css', '.json', '.webmanifest'):
            found = re.findall(r'\?v=[0-9A-Za-z-]+', path.read_text(encoding='utf8', errors='replace'))
            name = path.relative_to(ROOT).as_posix()
            assert len(found) == sum(count for pattern, count, _ in hosting.TARGETS.get(name, []) if pattern is hosting.ASSET), name


def test_stamp_check_and_reset_round_trip(shell):
    original = {name: (shell / name).read_bytes() for name in hosting.TARGETS}
    with pytest.raises(RuntimeError, match='not stamped'):
        hosting.check(shell)
    hosting.write(HEAD, shell)
    assert hosting.check(shell, fake_git()) == HEAD
    assert f"const VERSION='{HEAD}';" in (shell / 'public/sw.js').read_text()
    html = (shell / 'public/index.html').read_text(encoding='utf8')
    assert html.count(f'?v={HEAD}') == 4 and f'App version {HEAD[:12]}</small>' in html
    assert f'/audio-worklet.js?v={HEAD}' in (shell / 'public/app.js').read_text(encoding='utf8')
    hosting.write(HEAD + '-dirty', shell)
    assert hosting.check(shell, fake_git()) == HEAD + '-dirty'
    assert f'App version {HEAD[:12]}-dirty</small>' in (shell / 'index.html').read_text(encoding='utf8')
    hosting.write(hosting.PLACEHOLDER, shell)
    assert {name: (shell / name).read_bytes() for name in hosting.TARGETS} == original


def test_check_rejects_a_partially_stamped_shell(shell):
    hosting.write(HEAD, shell)
    worker = shell / 'public/sw.js'
    worker.write_text(worker.read_text().replace(HEAD, 'a' * 40))
    with pytest.raises(RuntimeError, match='other than'):
        hosting.check(shell)
    hosting.write(HEAD, shell)
    (shell / 'index.html').write_text((shell / 'index.html').read_text(encoding='utf8') + ' ', encoding='utf8')
    with pytest.raises(RuntimeError, match='differ'):
        hosting.check(shell)


def test_check_binds_the_stamp_to_head_and_uncommitted_hosting_files(tmp_path):
    repo = tmp_path / 'repo'
    for name in hosting.TARGETS:
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, repo / name)
    (repo / 'public/app.css').write_text('body{}\n')
    def git(argv, **kwargs):
        return subprocess.run(argv, **{**kwargs, 'cwd': repo})
    def commit(message):
        git(['git', 'add', '-A'], check=True)
        git(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', message], check=True)
        return git(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    git(['git', 'init', '-q'], check=True)
    first = commit('first')
    hosting.write(first, repo)
    assert hosting.check(repo, git) == first
    (repo / 'public/app.css').write_text('body{color:red}\n')
    with pytest.raises(RuntimeError, match='changed after stamping'):
        hosting.check(repo, git)
    hosting.write(first + '-dirty', repo)
    assert hosting.check(repo, git) == first + '-dirty'
    hosting.write(hosting.PLACEHOLDER, repo)
    second = commit('second')
    hosting.write(first, repo)
    with pytest.raises(RuntimeError, match=f'HEAD is {second}'):
        hosting.check(repo, git)
    hosting.write(first + '-dirty', repo)
    with pytest.raises(RuntimeError, match=f'HEAD is {second}'):
        hosting.check(repo, git)
    hosting.write(second, repo)
    assert hosting.check(repo, git) == second


def test_dirty_hosting_tree_is_refused_unless_marked(monkeypatch, capsys):
    written = []
    monkeypatch.setattr(hosting, 'write', written.append)
    assert hosting.main([], git=fake_git(' M public/app.js\n')) == 2
    assert 'public/app.js' in capsys.readouterr().err and written == []
    assert hosting.main(['--allow-dirty'], git=fake_git(' M public/app.js\n')) == 0
    assert hosting.main([], git=fake_git()) == 0
    assert written == [HEAD + '-dirty', HEAD]
    out = capsys.readouterr().out
    assert 'hosting:alert-disaster' in out and '--reset' in out and f'`{HEAD}`' in out.splitlines()[-1]


def test_hosting_deploy_runs_the_stamp_check():
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['hosting']['predeploy'] == ['python scripts/stamp_hosting.py --check']
    assert hosting.main(['--check']) == 1  # the committed shell is unstamped
