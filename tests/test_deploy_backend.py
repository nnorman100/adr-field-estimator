"""The backend deploy command never inherits the staged workspace flag or moves traffic."""
import fnmatch
import shutil
import subprocess
import pytest
from scripts import deploy_backend as deploy
from scripts import release_stamp

HEAD = '0123456789abcdef0123456789abcdef01234567'


def fake_git(status='', head=HEAD):
    calls = []
    def git(argv, **kwargs):
        calls.append(argv)
        assert kwargs['cwd'] == release_stamp.ROOT and kwargs['check']
        return subprocess.CompletedProcess(argv, 0, stdout={'rev-parse': head + '\n', 'status': status}[argv[1]])
    git.calls = calls
    return git


@pytest.fixture(autouse=True)
def stamp_path(monkeypatch, tmp_path):
    monkeypatch.setattr(deploy, 'STAMP', tmp_path / 'SOURCE_COMMIT')
    return tmp_path / 'SOURCE_COMMIT'


def test_workspaces_off_is_explicit_and_receives_no_traffic():
    argv = deploy.command('off', 'workspaces-off-1', HEAD)
    assert '--update-env-vars=WORKSPACES_ENABLED=false' in argv
    assert '--no-traffic' in argv and '--tag=workspaces-off-1' in argv
    for flag in ('--region=us-west2', '--project=alert-disaster-field-2026', '--billing-project=alert-disaster-field-2026',
                 '--service-account=adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com',
                 '--max-instances=2', '--concurrency=20', '--timeout=3600', '--allow-unauthenticated',
                 '--update-labels=source-commit=' + HEAD):
        assert flag in argv
    assert '--update-env-vars=WORKSPACES_ENABLED=true' in deploy.command('on', 'workspaces-on-1', HEAD)


@pytest.mark.parametrize('argv', [['--tag', 'stage-1', '--yes'], ['--workspaces', 'maybe', '--tag', 'stage-1', '--yes'],
                                  ['--workspaces', 'off', '--yes'], ['--workspaces', 'off', '--tag', 'Bad_Tag', '--yes']])
def test_missing_or_invalid_choice_runs_nothing(argv):
    with pytest.raises(SystemExit):
        deploy.main(argv, run=lambda *args, **kwargs: pytest.fail('gcloud ran'), git=fake_git())


def test_dry_run_and_unconfirmed_deploy_run_nothing(capsys, stamp_path):
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--dry-run'], run=never, git=fake_git()) == 0
    out = capsys.readouterr().out
    assert 'WORKSPACES_ENABLED=false' in out and 'source-commit=' + HEAD in out
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1'], run=never, git=fake_git()) == 2
    assert not stamp_path.exists()


def test_confirmed_deploy_stamps_the_build_context_and_cleans_up(capsys, stamp_path):
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        assert stamp_path.read_text() == HEAD + '\n'
        return subprocess.CompletedProcess(argv, 0)
    git = fake_git()
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=run, git=git) == 0
    assert calls[0][1:] == deploy.command('off', 'stage-1', HEAD)[1:]
    assert ['git', 'status', '--porcelain', '--untracked-files=all', '--', 'backend'] in git.calls
    assert not stamp_path.exists()
    row = capsys.readouterr().out.splitlines()[-1]
    assert row.startswith('| 20') and '(tag `stage-1`)' in row and f'`{HEAD}`' in row and '0% (staged)' in row


def test_failed_deploy_still_removes_the_stamp(capsys, stamp_path):
    def run(argv, **kwargs):
        raise KeyboardInterrupt
    with pytest.raises(KeyboardInterrupt):
        deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=run, git=fake_git())
    assert not stamp_path.exists()
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'],
                       run=lambda argv, **kwargs: subprocess.CompletedProcess(argv, 1), git=fake_git()) == 1
    assert 'RELEASES.md' not in capsys.readouterr().out and not stamp_path.exists()


def test_dirty_backend_is_refused_unless_marked(capsys, stamp_path):
    dirty = fake_git(' M backend/main.py\n?? backend/new.py\n')
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=never, git=dirty) == 2
    assert 'backend/main.py' in capsys.readouterr().err and not stamp_path.exists()
    calls = []
    assert deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes', '--allow-dirty'],
                       run=lambda argv, **kwargs: calls.append(stamp_path.read_text()) or subprocess.CompletedProcess(argv, 0),
                       git=dirty) == 0
    assert calls == [HEAD + '-dirty\n']


def test_source_commit_requires_a_full_head_hash():
    with pytest.raises(RuntimeError):
        release_stamp.source_commit(['backend'], git=fake_git(head='abc123'))
    assert release_stamp.source_commit(['backend'], git=fake_git()) == HEAD


def test_stamp_file_reaches_the_image_but_not_git(tmp_path):
    # gcloud filters the upload with .gcloudignore (gitignore syntax); Docker filters the copy with .dockerignore.
    root = release_stamp.ROOT
    shutil.copyfile(root / 'backend/.gcloudignore', tmp_path / '.gitignore')
    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True)
    assert subprocess.run(['git', 'check-ignore', '-q', '--no-index', 'SOURCE_COMMIT'], cwd=tmp_path).returncode == 1
    patterns = [line.strip().rstrip('/') for line in (root / 'backend/.dockerignore').read_text().splitlines()
                if line.strip() and not line.startswith(('#', '!'))]
    assert not any(fnmatch.fnmatchcase('SOURCE_COMMIT', pattern) for pattern in patterns)
    assert subprocess.run(['git', 'check-ignore', '-q', 'backend/SOURCE_COMMIT'], cwd=root).returncode == 0
