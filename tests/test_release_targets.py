"""Offline target selection regressions; never run an authenticated verifier."""

import argparse
import sys

import pytest

from scripts import verify_live_release as verifier


HOST = 'alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app'
CANDIDATE = 'https://harden-fixes---' + HOST


@pytest.mark.parametrize('tag', ['a', 'harden-fixes', 'workspaces', 'v13-hup', 'a' * 16])
def test_tag_constructs_only_the_dedicated_url(tag):
    expected = 'https://' + tag + '---' + HOST
    assert verifier.backend_url(tag) == expected
    assert verifier.service_url(expected) == expected


@pytest.mark.parametrize(
    'tag',
    [
        '',
        'A',
        '1abc',
        '-abc',
        'abc-',
        'a' * 17,
        'a' * 63,
        'a' * 64,
        'a.b',
        'a/b',
        'a@evil',
        'a:443',
        'a?b',
        'a#b',
        'a_b',
        'a%2fb',
        'a\n',
        ' a',
        'https://evil.test',
    ],
)
def test_invalid_tags_are_rejected(tag):
    with pytest.raises(argparse.ArgumentTypeError):
        verifier.backend_url(tag)
    with pytest.raises(argparse.ArgumentTypeError):
        verifier.service_url('https://' + tag + '---' + HOST)


@pytest.mark.parametrize(
    'url',
    [
        CANDIDATE + '.evil.test',
        CANDIDATE + '/',
        CANDIDATE + '/api',
        CANDIDATE + '?',
        CANDIDATE + '?x=1',
        CANDIDATE + '#',
        CANDIDATE + ':443',
        CANDIDATE + '\n',
        ' ' + CANDIDATE,
        CANDIDATE.replace('https:', 'http:'),
        CANDIDATE.replace('https://', 'https://user@'),
        CANDIDATE + '@evil.test',
        CANDIDATE.replace('ecyxym3iqa', 'other'),
        CANDIDATE.replace('harden-fixes---', '').replace('https://', 'https://evil.'),
        verifier.PRODUCTION + '/',
        verifier.PRODUCTION + '.evil.test',
    ],
)
def test_url_spoofing_and_url_components_are_rejected(url):
    with pytest.raises(argparse.ArgumentTypeError):
        verifier.service_url(url)


@pytest.mark.parametrize(
    'arguments,expected',
    [
        (['--backend-tag', 'harden-fixes'], CANDIDATE),
        (['--production'], verifier.PRODUCTION),
        ([verifier.PRODUCTION], verifier.PRODUCTION),
        (['https://' + HOST], 'https://' + HOST),
        ([verifier.STAGED], verifier.STAGED),
        ([verifier.WORKSPACE_STAGE], verifier.WORKSPACE_STAGE),
    ],
)
def test_public_cli_routes_explicit_targets_without_credentials(monkeypatch, arguments, expected):
    calls = []
    monkeypatch.setattr(sys, 'argv', ['verifier', *arguments, '--public'])
    monkeypatch.setattr(verifier, 'public', lambda: calls.append(verifier.SERVICE))
    monkeypatch.setattr(verifier, 'staff_session', lambda: pytest.fail('Read credentials'))
    verifier.cli()
    assert calls == [expected]


@pytest.mark.parametrize(
    'arguments',
    [
        [],
        ['--backend-tag', ''],
        ['--backend-tag'],
        ['--production', '--backend-tag', 'harden-fixes'],
        [CANDIDATE, '--production'],
        [CANDIDATE, '--backend-tag', 'harden-fixes'],
        ['--backend-tag', 'one', '--backend-tag', 'two'],
    ],
)
def test_bad_cli_selection_fails_before_authentication(monkeypatch, arguments):
    monkeypatch.setattr(sys, 'argv', ['verifier', *arguments, '--token-stdin'])
    monkeypatch.setattr(verifier, 'main', lambda: pytest.fail('Started authenticated run'))
    with pytest.raises(SystemExit) as error:
        verifier.cli()
    assert error.value.code == 2


def test_backend_api_does_not_follow_redirects(monkeypatch):
    monkeypatch.setattr(verifier, 'SERVICE', CANDIDATE)
    calls = []

    class Redirect:
        status_code = 307

    def request(*args, **kwargs):
        calls.append((args, kwargs))
        return Redirect()

    monkeypatch.setattr(verifier.requests, 'request', request)
    with pytest.raises(RuntimeError, match='HTTP 307'):
        verifier.check('POST', '/api/inspections', 'synthetic-memory-token', {})
    assert calls[0][0] == ('POST', CANDIDATE + '/api/inspections')
    assert calls[0][1]['allow_redirects'] is False


def test_live_handshake_rejects_redirect_before_sending_authentication():
    import asyncio
    from websockets.datastructures import Headers
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response

    async def verify():
        connection = verifier.live_connection(CANDIDATE.replace('https:', 'wss:') + '/api/live')
        for destination in ['wss://evil.test/api/live', '/different-path']:
            error = InvalidStatus(
                Response(307, 'Temporary Redirect', Headers({'Location': destination}))
            )
            assert connection.process_redirect(error) is error

    asyncio.run(verify())
