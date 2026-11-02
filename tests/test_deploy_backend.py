"""The backend deploy command never inherits the staged workspace flag or moves traffic."""

import fnmatch
import json
import re
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
        return subprocess.CompletedProcess(
            argv, 0, stdout={'rev-parse': head + '\n', 'status': status}[argv[1]]
        )

    git.calls = calls
    return git


def fake_describe(env, returncode=0):
    calls = []

    def describe(argv):
        calls.append(argv)
        items = [{'name': key, 'value': value} for key, value in env.items()]
        template = {'spec': {'containers': [{'env': items}]}}
        stdout = json.dumps({'spec': {'template': template}}) if returncode == 0 else ''
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout)

    describe.calls = calls
    return describe


@pytest.fixture(autouse=True)
def service_template(monkeypatch):
    monkeypatch.setattr(
        deploy, 'describe_service', fake_describe({'STAFF_EMAILS': 'owner@example.com'})
    )


@pytest.fixture(autouse=True)
def stamp_path(monkeypatch, tmp_path):
    monkeypatch.setattr(deploy, 'STAMP', tmp_path / 'SOURCE_COMMIT')
    return tmp_path / 'SOURCE_COMMIT'


def env_flag(argv):
    flags = [item for item in argv if item.startswith('--update-env-vars=')]
    assert len(flags) == 1
    return flags[0]


def test_workspaces_off_is_explicit_and_receives_no_traffic():
    argv = deploy.command('off', 'workspaces-off-1', HEAD)
    assert env_flag(argv) == (
        '--update-env-vars=^|^WORKSPACES_ENABLED=false'
        '|AI_FEATURES=readiness|PRICE_BOOKS_ENABLED=false'
    )
    assert '--no-traffic' in argv and '--tag=workspaces-off-1' in argv
    # The Maps key is mounted from its Secret Manager secret, never passed as a value.
    assert '--update-secrets=MAPS_API_KEY=dryscope-maps-api-key:latest' in argv
    assert not any('--set-secrets' in a or 'AIza' in a for a in argv)
    for flag in (
        '--region=us-west2',
        '--project=alert-disaster-field-2026',
        '--billing-project=alert-disaster-field-2026',
        '--service-account=adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com',
        '--max-instances=2',
        '--concurrency=20',
        '--timeout=3600',
        '--allow-unauthenticated',
        '--update-labels=source-commit=' + HEAD,
    ):
        assert flag in argv
    assert 'WORKSPACES_ENABLED=true' in env_flag(deploy.command('on', 'workspaces-on-1', HEAD))


def test_feature_baseline_changes_only_when_asked():
    overridden = deploy.command(
        'on',
        'features-on-1',
        HEAD,
        ai_features='drying_watch,readiness',
        price_books='on',
    )
    assert env_flag(overridden) == (
        '--update-env-vars=^|^WORKSPACES_ENABLED=true'
        '|AI_FEATURES=drying_watch,readiness|PRICE_BOOKS_ENABLED=true'
    )
    cleared = deploy.command('on', 'features-off-1', HEAD, ai_features='', price_books='off')
    assert '|AI_FEATURES=|PRICE_BOOKS_ENABLED=false' in env_flag(cleared)


def test_dry_run_prints_a_deliberate_feature_baseline(capsys):
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert (
        deploy.main(
            [
                '--workspaces',
                'on',
                '--tag',
                'stage-1',
                '--ai-features',
                'none',
                '--price-books',
                'on',
                '--dry-run',
            ],
            run=never,
            git=fake_git(),
        )
        == 0
    )
    out = capsys.readouterr().out
    assert (
        "Feature baseline: WORKSPACES_ENABLED=true AI_FEATURES='' PRICE_BOOKS_ENABLED=true" in out
    )
    assert '|AI_FEATURES=|PRICE_BOOKS_ENABLED=true' in out
    with pytest.raises(SystemExit):
        deploy.main(
            [
                '--workspaces',
                'on',
                '--tag',
                'stage-1',
                '--ai-features',
                'not-a-feature',
                '--dry-run',
            ],
            run=never,
            git=fake_git(),
        )


@pytest.mark.parametrize(
    'argv',
    [
        ['--tag', 'stage-1', '--yes'],
        ['--workspaces', 'maybe', '--tag', 'stage-1', '--yes'],
        ['--workspaces', 'off', '--yes'],
        ['--workspaces', 'off', '--tag', 'Bad_Tag', '--yes'],
    ],
)
def test_missing_or_invalid_choice_runs_nothing(argv):
    with pytest.raises(SystemExit):
        deploy.main(argv, run=lambda *args, **kwargs: pytest.fail('gcloud ran'), git=fake_git())


def test_dry_run_and_unconfirmed_deploy_run_nothing(capsys, stamp_path):
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert (
        deploy.main(
            ['--workspaces', 'off', '--tag', 'stage-1', '--dry-run'], run=never, git=fake_git()
        )
        == 0
    )
    out = capsys.readouterr().out
    assert 'WORKSPACES_ENABLED=false' in out and 'source-commit=' + HEAD in out
    assert (
        'Feature baseline: WORKSPACES_ENABLED=false AI_FEATURES=readiness PRICE_BOOKS_ENABLED=false'
        in out
    )
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
    assert (
        row.startswith('| 20')
        and '(tag `stage-1`)' in row
        and f'`{HEAD}`' in row
        and '0% (staged)' in row
    )


def test_failed_deploy_still_removes_the_stamp(capsys, stamp_path):
    def run(argv, **kwargs):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=run, git=fake_git())
    assert not stamp_path.exists()
    assert (
        deploy.main(
            ['--workspaces', 'off', '--tag', 'stage-1', '--yes'],
            run=lambda argv, **kwargs: subprocess.CompletedProcess(argv, 1),
            git=fake_git(),
        )
        == 1
    )
    assert 'RELEASES.md' not in capsys.readouterr().out and not stamp_path.exists()


def test_dirty_backend_is_refused_unless_marked(capsys, stamp_path):
    dirty = fake_git(' M backend/main.py\n?? backend/new.py\n')
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    assert (
        deploy.main(['--workspaces', 'off', '--tag', 'stage-1', '--yes'], run=never, git=dirty) == 2
    )
    assert 'backend/main.py' in capsys.readouterr().err and not stamp_path.exists()
    calls = []
    assert (
        deploy.main(
            ['--workspaces', 'off', '--tag', 'stage-1', '--yes', '--allow-dirty'],
            run=lambda argv, **kwargs: (
                calls.append(stamp_path.read_text()) or subprocess.CompletedProcess(argv, 0)
            ),
            git=dirty,
        )
        == 0
    )
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
    assert (
        subprocess.run(
            ['git', 'check-ignore', '-q', '--no-index', 'SOURCE_COMMIT'], cwd=tmp_path
        ).returncode
        == 1
    )
    patterns = [
        line.strip().rstrip('/')
        for line in (root / 'backend/.dockerignore').read_text().splitlines()
        if line.strip() and not line.startswith(('#', '!'))
    ]
    assert not any(fnmatch.fnmatchcase('SOURCE_COMMIT', pattern) for pattern in patterns)
    assert (
        subprocess.run(['git', 'check-ignore', '-q', 'backend/SOURCE_COMMIT'], cwd=root).returncode
        == 0
    )


def test_staff_emails_are_set_only_when_asked_for():
    plain = env_flag(deploy.command('on', 'tag-1', HEAD))
    assert 'STAFF_EMAILS' not in plain
    argv = deploy.command('on', 'tag-1', HEAD, staff_emails='a@example.com,b@example.com')
    assert parse_env_flag(env_flag(argv)) == {
        'WORKSPACES_ENABLED': 'true',
        'AI_FEATURES': 'readiness',
        'PRICE_BOOKS_ENABLED': 'false',
        'STAFF_EMAILS': 'a@example.com,b@example.com',
    }


def parse_env_flag(flag):
    """Split --update-env-vars the way gcloud does: '^X^' at the start makes X the list delimiter."""
    value = flag.split('=', 1)[1]
    delimiter = ','
    if value.startswith('^'):
        delimiter, value = value[1:].split('^', 1)
    pairs = {}
    for item in value.split(delimiter):
        key, sep, val = item.partition('=')
        assert sep and re.fullmatch(r'[A-Z_][A-Z0-9_]*', key), f'gcloud would reject {item!r}'
        pairs[key] = val
    return pairs


def test_staff_emails_flag_is_normalized_and_validated():
    assert deploy.staff_emails_value(' A@Example.com, ,b@example.com,a@example.com') == (
        'a@example.com,b@example.com'
    )
    for bad in ('', ' , ', 'not-an-email', 'a@example.com,^b@example.com', 'a|b@example.com'):
        with pytest.raises(deploy.argparse.ArgumentTypeError):
            deploy.staff_emails_value(bad)


def test_main_passes_staff_emails_to_the_deploy_command(capsys):
    code = deploy.main(
        [
            '--workspaces',
            'on',
            '--tag',
            'tag-1',
            '--staff-emails',
            'Owner@Example.com',
            '--dry-run',
        ],
        git=fake_git(),
    )
    assert code == 0
    assert 'STAFF_EMAILS=owner@example.com' in capsys.readouterr().out


@pytest.mark.parametrize(
    'template',
    [
        {'env': {}},
        {'env': {'STAFF_EMAILS': ''}},
        {'env': {'STAFF_EMAILS': ' , '}},
        {'env': {'STAFF_EMAILS': 'owner@example.com'}, 'returncode': 1},
    ],
)
@pytest.mark.parametrize('confirm', ['--dry-run', '--yes'])
def test_refuses_without_staff_emails_when_the_service_template_has_none(capsys, template, confirm):
    never = lambda *args, **kwargs: pytest.fail('gcloud deploy ran')
    describe = fake_describe(**template)
    code = deploy.main(
        ['--workspaces', 'off', '--tag', 'stage-1', confirm],
        run=never,
        git=fake_git(),
        describe=describe,
    )
    assert code == 2
    assert '--staff-emails' in capsys.readouterr().err
    assert describe.calls and describe.calls[0][1:4] == ['run', 'services', 'describe']


def test_inherits_the_template_staff_emails_when_the_flag_is_omitted(capsys):
    describe = fake_describe({'STAFF_EMAILS': 'owner@example.com'})
    code = deploy.main(
        ['--workspaces', 'off', '--tag', 'stage-1', '--dry-run'],
        run=lambda *args, **kwargs: pytest.fail('gcloud deploy ran'),
        git=fake_git(),
        describe=describe,
    )
    assert code == 0
    assert describe.calls
    printed = capsys.readouterr().out.splitlines()[-1]
    assert 'STAFF_EMAILS' not in printed


def test_an_explicit_staff_list_does_not_need_the_service_template(capsys):
    never = lambda *args, **kwargs: pytest.fail('gcloud ran')
    code = deploy.main(
        ['--workspaces', 'off', '--tag', 'stage-1', '--staff-emails', 'a@example.com', '--dry-run'],
        run=never,
        git=fake_git(),
        describe=never,
    )
    assert code == 0
    assert 'STAFF_EMAILS=a@example.com' in capsys.readouterr().out
