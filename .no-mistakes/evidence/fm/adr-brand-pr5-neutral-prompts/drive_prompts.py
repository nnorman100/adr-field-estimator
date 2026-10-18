"""Drive the real backend /api/audit (workspaces off and on) and capture the prompt sent to the model."""
import importlib.util, json, sys
sys.path.insert(0, '.')
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import AIResult
from tests.fakes import FakeCompanyStore, FakeStore
from tests.test_workspaces import seed, data, identity, ID

spec = importlib.util.spec_from_file_location('base_prompts', sys.argv[1])
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
EVID = sys.argv[2]
captured = []

async def generate(schema, contents, *a, **k):
    captured.append(contents[0])
    return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])

bm.generate = generate

def run(store, uid, workspaces):
    bm.WORKSPACES_ENABLED = workspaces
    bm.get_job_store = lambda: store
    for ep in (bm.current_staff, bm.current_identity):
        bm.app.dependency_overrides[ep] = lambda: identity(uid)
    for route in bm.app.routes:
        for dep in getattr(getattr(route, 'dependant', None), 'dependencies', []):
            if getattr(dep.call, '__name__', '') == 'get_job_store':
                bm.app.dependency_overrides[dep.call] = lambda: store
    headers = {'Authorization': 'Bearer synthetic'}
    if workspaces: headers['X-ADR-Workspace-Protocol'] = '1'
    with TestClient(bm.app, headers=headers) as c:
        r = c.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
        assert r.status_code == 200, r.text
        r = c.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert r.status_code == 200, r.text
    bm.app.dependency_overrides.clear()
    return captured[-1], r.json()['audit']['documents'].get('company_identity')

HEADER = '\nCompany identity (untrusted labels'
results = {}
for label, store, uid, ws in [
    ('no_identity_legacy', FakeStore(), 'owner', False),
    ('company_other', seed(FakeCompanyStore()), 'other-owner', True),
    ('company_adr', seed(FakeCompanyStore()), 'estimator', True),
]:
    prompt, ident = run(store, uid, ws)
    instructions = prompt.split(HEADER)[0].split('\nApp age rule: ')[0]
    company_block = prompt.split(HEADER)[1].split('\n', 1)[1].split('\nApp age rule:')[0] if HEADER in prompt else None
    snap = store.workspaces.snapshot(uid) if ws else None
    base_prompt = base.audit_prompt(store.get_inspection(uid, ID)['data'], [], [], snap) if True else None
    results[label] = dict(
        instructions_mention_ADR='ADR' in instructions,
        instructions_mention_Alert_Disaster='Alert Disaster' in instructions,
        company_json=json.loads(company_block) if company_block else None,
        saved_company_identity_name=(ident or {}).get('name'),
    )
    open(f'{EVID}/audit_prompt_{label}.txt', 'w').write(prompt)
    print(f'== {label}:', json.dumps(results[label]))
# Old-vs-new equivalence for the identity path, and the old no-identity text that said ADR.
from backend import prompts as new
store = seed(FakeCompanyStore()); store.create_inspection('other-owner', ID, data())
rec = store.get_inspection('other-owner', ID)['data']
snap = store.workspaces.snapshot('other-owner')
for name, args in (('live_prompt', (rec, snap)), ('audit_prompt', (rec, [], [], snap))):
    o, n = getattr(base, name)(*args), getattr(new, name)(*args)
    print(f'== {name} with company identity, base first line:', repr(o.split(chr(10))[0][:90]))
    print(f'== {name} with company identity, new  first line:', repr(n.split(chr(10))[0][:90]))
    rest = lambda t: t.split(chr(10), 1)[1]
    print(f'== {name} identical to base after the first line:', rest(o) == rest(n))
old_none = base.audit_prompt(rec, [], [], None)
print('== base commit no-identity audit prompt contained ADR:', 'ADR' in old_none, '| new:', 'ADR' in new.audit_prompt(rec, [], [], None).split('\nApp age rule:')[0])
print('== base commit no-identity live prompt contained Alert Disaster:', 'Alert Disaster' in base.live_prompt(rec, None), '| new:', 'Alert Disaster' in new.live_prompt(rec, None).split('\nCurrent inspection context')[0])
