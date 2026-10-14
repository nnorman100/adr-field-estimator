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
    # The homeowner signing page is served before the app shell's catch-all rewrite.
    assert [r['source'] for r in config['hosting']['rewrites']] == ['/api/**', '/sign', '**']
    assert config['hosting']['rewrites'][1]['destination'] == '/sign.html'
    no_store = {
        h['source']
        for h in config['hosting']['headers']
        if {'key': 'Cache-Control', 'value': 'no-store'} in h['headers']
    }
    assert {'/sign', '/sign.html'} <= no_store


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
