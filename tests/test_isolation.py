"""Protect the dedicated project boundary against accidental shared deployment."""

import json
import runpy
from pathlib import Path
from unittest.mock import patch
import pytest

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'alert-disaster-field-2026'


def test_hosting_and_database_use_dedicated_project():
    rc = json.loads((ROOT / '.firebaserc').read_text())
    assert rc['projects']['default'] == PROJECT
    assert set(rc['targets']) == {PROJECT}
    assert rc['targets'][PROJECT]['hosting']['alert-disaster'] == [PROJECT]
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['firestore']['database'] == '(default)'
    assert config['firestore']['location'] == 'us-west2'
    api = config['hosting']['rewrites'][0]
    assert api['source'] == '/api/**'
    assert api['run']['serviceId'] == 'alert-disaster-field-estimator'
    assert api['run']['region'] == 'us-west2'
    # The site root is the static landing page; the homeowner signing page and the app shell have
    # their own rewrites and no catch-all, so unknown paths get the 404 page instead of the app.
    assert [r['source'] for r in config['hosting']['rewrites']] == [
        '/api/**',
        '/sign',
        '/app',
        '/app/**',
    ]
    assert config['hosting']['rewrites'][1]['destination'] == '/sign.html'
    assert [r['destination'] for r in config['hosting']['rewrites'][2:]] == ['/app.html'] * 2
    assert config['hosting']['redirects'] == [
        {'source': '/app.html', 'destination': '/app', 'type': 301}
    ]
    assert config['hosting']['trailingSlash'] is False

    def sources(key, value):
        return {
            h['source']
            for h in config['hosting']['headers']
            if {'key': key, 'value': value} in h['headers']
        }

    app_and_signing = {'/app', '/app/**', '/app.html', '/sign', '/sign.html'}
    assert {'/', '/index.html', '/sw.js', '/manifest.webmanifest'} | app_and_signing <= sources(
        'Cache-Control', 'no-store'
    )
    # Only the landing page is indexed, and only the landing page may register WebMCP tools.
    assert sources('X-Robots-Tag', 'noindex, nofollow') == app_and_signing
    assert sources('Permissions-Policy', 'tools=()') == app_and_signing
    landing = (ROOT / 'public/index.html').read_text(encoding='utf8')
    assert 'name="robots"' not in landing
    assert 'name="robots" content="noindex, nofollow"' in (ROOT / 'public/app.html').read_text(
        encoding='utf8'
    )
    assert (ROOT / 'public/robots.txt').read_text(encoding='utf8').splitlines()[-1] == (
        'Sitemap: https://alert-disaster-field-2026.web.app/sitemap.xml'
    )
    sitemap = (ROOT / 'public/sitemap.xml').read_text(encoding='utf8')
    assert (
        sitemap.count('<loc>') == 1
        and '<loc>https://alert-disaster-field-2026.web.app/</loc>' in sitemap
    )
    manifest = json.loads((ROOT / 'public/manifest.webmanifest').read_text(encoding='utf8'))
    assert (manifest['id'], manifest['start_url'], manifest['scope']) == ('/', '/app', '/')


def test_service_rejects_another_project_before_initializing_ai(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'backend'))
    monkeypatch.setenv('GOOGLE_CLOUD_PROJECT', 'mitigation-project')
    with patch('google.genai.Client') as client:
        with pytest.raises(RuntimeError, match='dedicated'):
            runpy.run_path(str(ROOT / 'backend' / 'main.py'))
        client.assert_not_called()


def test_service_defaults_to_dedicated_project(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'backend'))
    monkeypatch.delenv('GOOGLE_CLOUD_PROJECT', raising=False)
    monkeypatch.delenv('GOOGLE_CLOUD_LOCATION', raising=False)
    with patch('google.genai.Client') as client:
        result = runpy.run_path(str(ROOT / 'backend' / 'main.py'))
        assert result['PROJECT_ID'] == PROJECT
        assert result['LOCATION'] == 'global'
        result['get_ai_client']()
        assert client.call_args.kwargs['project'] == PROJECT


def test_no_shared_api_url_in_either_frontend():
    public = (ROOT / 'public' / 'index.html').read_bytes()
    assert public == (ROOT / 'index.html').read_bytes()
    assert b'219826144890' not in public
    assert b'.run.app' not in public
    app = (ROOT / 'public' / 'app.js').read_text()
    assert 'fetch(path,' in app and '219826144890' not in app
