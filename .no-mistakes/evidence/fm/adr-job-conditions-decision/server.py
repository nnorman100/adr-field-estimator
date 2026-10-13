"""Disposable probe server: real backend + the repo's synthetic browser harness, plus scope-AI probes."""
import sys, json
from types import SimpleNamespace
ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
import tests.browser_server as bs
import uvicorn
from fastapi import Request
bm = bs.bm
bm.ORIGINS.extend(['http://localhost:8766', 'http://127.0.0.1:8766'])
probe = {'retired': False, 'schema': None, 'prompt': None}
orig_generate = bs.generate

async def generate(**kwargs):
    schema = kwargs['config'].response_schema
    if isinstance(schema, dict) and schema == bm.scope_response_schema():
        probe['schema'] = schema
        probe['prompt'] = json.dumps(kwargs.get('contents'), default=str)
        if probe['retired']:
            return SimpleNamespace(text=json.dumps({'changes': [
                {'field': 'granite_removal', 'room': None, 'value': True, 'source_quote': 'Kitchen cabinets come out under the granite.'},
                {'field': 'has_crawl_space', 'room': None, 'value': True, 'source_quote': 'There is a crawl space.'},
                {'field': 'water_heater_loss', 'room': None, 'value': True, 'source_quote': 'Garage water heater leaked.'},
            ], 'questions': []}))
    return await orig_generate(**kwargs)

bm.get_ai_client = lambda: SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))

@bm.app.post('/__probe/retired')
async def set_retired(request: Request):
    probe['retired'] = (await request.json())['on']
    return {'on': probe['retired']}

@bm.app.get('/__probe/scope')
async def get_probe():
    return {'schema': probe['schema'], 'prompt': probe['prompt']}

# Probe routes must precede the static mount registered by the harness.
routes = bm.app.router.routes
mount = [r for r in routes if getattr(r, 'name', '') == 'frontend']
for m in mount:
    routes.remove(m); routes.append(m)
uvicorn.run(bm.app, host='127.0.0.1', port=8766, log_level='warning')
