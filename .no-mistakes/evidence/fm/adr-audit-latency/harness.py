"""Disposable live harness: the real backend app + frontend from tests/browser_server.py,
with a controllable fake Vertex provider that can stall audit calls. Production timing constants."""
import asyncio, json, sys, os, time
ROOT = os.environ['ADR_ROOT']
sys.path.insert(0, ROOT)
from types import SimpleNamespace
import tests.browser_server as server
import backend.main as bm
from fastapi import Request
import uvicorn

base_client = bm.get_ai_client()
plan = {'delays': [], 'error': False}
calls = []

async def generate(**kwargs):
    schema = kwargs['config'].response_schema
    if schema is not bm.AIResult:
        return await base_client.aio.models.generate_content(**kwargs)
    tc = kwargs['config'].thinking_config
    call = dict(n=len(calls) + 1, thinking=str(tc.thinking_level) if tc else None, start=time.monotonic(), outcome='running')
    calls.append(call)
    if plan['error']:
        call['outcome'] = 'error'
        raise RuntimeError('synthetic provider unavailable')
    delay = plan['delays'].pop(0) if plan['delays'] else 0
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        call['outcome'] = 'cancelled'; call['after_s'] = round(time.monotonic() - call['start'], 2)
        raise
    call['outcome'] = 'finished'; call['after_s'] = round(time.monotonic() - call['start'], 2)
    return await base_client.aio.models.generate_content(**kwargs)

bm.get_ai_client = lambda: SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))

@bm.app.post('/__live/plan')
async def set_plan(request: Request):
    body = await request.json()
    plan.update(delays=list(body.get('delays', [])), error=bool(body.get('error')))
    calls.clear()
    return plan

@bm.app.get('/__live/calls')
async def get_calls():
    return [{k: v for k, v in c.items() if k != 'start'} for c in calls]

# Re-mount order: the static mount in browser_server is last; move our routes before it.
routes = bm.app.router.routes
mount = [r for r in routes if getattr(r, 'name', '') == 'frontend']
for m in mount:
    routes.remove(m); routes.append(m)
print(json.dumps({'constants': dict(deadline=bm.REST_DEADLINE_SECONDS, attempt=bm.AUDIT_ATTEMPT_SECONDS, retry_min=bm.AUDIT_RETRY_MIN_SECONDS, reserve=bm.AUDIT_SAVE_RESERVE_SECONDS, thinking=str(bm.AUDIT_THINKING_LEVEL))}), flush=True)
uvicorn.run(bm.app, host='127.0.0.1', port=int(os.environ.get('PORT', '8799')), log_level='warning')
