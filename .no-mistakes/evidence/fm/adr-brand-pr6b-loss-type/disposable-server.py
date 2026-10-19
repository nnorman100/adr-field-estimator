"""Disposable launcher: the repo's local browser harness plus a fake model that answers loss."""
import sys, json, os
from types import SimpleNamespace
ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
os.environ['ADR_BROWSER_PORT'] = '8799'
import tests.browser_server as hs
bm = hs.bm
bm.ORIGINS.append('http://localhost:8799')
base = hs.generate
MODE = {'value': 'good'}

async def generate(**kwargs):
    schema = kwargs['config'].response_schema
    text = str(kwargs['contents'])
    if isinstance(schema, dict) and schema == bm.scope_response_schema() and 'Laundry' in text:
        q1 = 'Laundry is black water, category 3, no mold, 40 SF drywall.'
        q2 = 'Closet has mold, 20 SF drywall.'
        loss1 = 'fire' if MODE['value'] == 'bad' else 'water'
        return SimpleNamespace(text=json.dumps({'changes': [
            {'field': 'category', 'room': 'Laundry', 'value': 3, 'source_quote': q1},
            {'field': 'loss', 'room': 'Laundry', 'value': loss1, 'source_quote': q1},
            {'field': 'finished_sf', 'room': 'Laundry', 'value': 40, 'source_quote': q1},
            {'field': 'category', 'room': 'Closet', 'value': 3, 'source_quote': q2},
            {'field': 'loss', 'room': 'Closet', 'value': 'both' if 'Closet has both' in text else 'mold', 'source_quote': q2},
            {'field': 'finished_sf', 'room': 'Closet', 'value': 20, 'source_quote': q2},
        ], 'questions': []}))
    return await base(**kwargs)

bm.get_ai_client = lambda: SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))

@bm.app.post('/__lt/mode')
async def mode(body: dict):
    MODE['value'] = body['value']
    return MODE

# Re-mount static after the new route so the route wins.
bm.app.router.routes = [r for r in bm.app.router.routes if getattr(r, 'name', '') != 'frontend'] 
from fastapi.staticfiles import StaticFiles
bm.app.mount('/', StaticFiles(directory=ROOT + '/public', html=True), name='frontend')
import uvicorn
uvicorn.run(bm.app, host='127.0.0.1', port=8799, log_level='warning')
