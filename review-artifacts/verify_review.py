"""Offline review probes; application files are not modified."""
from unittest.mock import patch
from types import SimpleNamespace
import json
with patch('google.genai.Client', side_effect=RuntimeError('review offline')):
    import backend.main as m
from fastapi.testclient import TestClient
c = TestClient(m.app)
payload = dict(address='Local Review Test Property', year_built=1960,
               has_crawl_space=True, area='Garage water heater', is_after_hours=False,
               transcript='Dry standard. No wet drywall. No granite. No demolition performed.')
m.genai_client = None
r = c.post('/api/audit', json=payload).json()
assert r['adr_estimate']['proposed_cost'] == 2499
assert 'granite' in r['adr_estimate']['recommendations_html']
assert 'was performed' in r['iicrc_defense_letter']
assert not any(x['unit_price'] == 101.25 for x in r['xactimate_scope'])
print('Unavailable AI: unrelated $2499 granite scope and completed-work assertion confirmed')
r = c.post('/api/ocr-meter', json={'photo_base64':'not-an-image'}).json()
assert r['value'] == '99.9% SAT'
print('Unavailable OCR: invalid image returned fabricated 99.9% SAT')
class FailingModels:
    def generate_content(self, **kwargs):
        raise RuntimeError('review provider failure')
m.genai_client = SimpleNamespace(models=FailingModels())
r = c.post('/api/ocr-meter', json={'photo_base64':'aGVsbG8='}).json()
assert r['value'] == '99.9% SAT'
print('Failed OCR provider: fabricated 99.9% SAT confirmed')
class InvalidModels:
    def generate_content(self, **kwargs):
        return SimpleNamespace(text=json.dumps({'adr_estimate':{'lead_notice_required':False,'proposed_cost':-999}}))
m.genai_client = SimpleNamespace(models=InvalidModels())
r = c.post('/api/audit', json=payload)
assert r.status_code == 200 and r.json()['adr_estimate']['proposed_cost'] == -999
print('Invalid model schema: negative price and contradictory pre-1978 flag accepted')
r = c.post('/api/authorize',json={'address':'Synthetic', 'proposed_cost':-1,'signature_png':'','photos_count':-1})
assert r.status_code == 200 and r.json()['status'] == 'success'
print('Unauthenticated authorization: empty signature and negative cost accepted')
assert m.normalize_xactimate_items([dict(qty=2,price=100,waste=10,total=1)])[0]['total'] == 1
print('Waste arithmetic: supplied $1 retained instead of computed $220')
print('All independent offline review probes confirmed')
