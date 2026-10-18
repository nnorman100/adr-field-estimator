"""Disposable wrapper: real ADR backend+frontend via tests/browser_server.py, with an Acme-like fake audit model."""
import sys, json, runpy
from types import SimpleNamespace
ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
import tests.browser_server as hs
bm = hs.bm
original = hs.generate
async def generate(**kwargs):
    if kwargs['config'].response_schema is bm.AIResult:
        # Shape of the real 2026-10-17 Gemini output for 1234 Acme St.
        return SimpleNamespace(text=json.dumps({
            'summary': 'The JSON metadata shows Room 1 with clean-water drywall damage. Photos are tagged to Room 1 and Hallway.\nThe inspection JSON lists photo_log entries without meter readings.',
            'suggestions': ['Confirm the moisture readings recorded in the JSON metadata.', 'Document drying progress for Room 1.'],
            'unpriced_work': [],
            'testing_advice': ['Lead or asbestos testing may be needed given the 1978 build year before demolition.'],
        }))
    return await original(**kwargs)
bm.get_ai_client = lambda: SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
# Re-run only the TLS/uvicorn launch block from the harness.
src = open(ROOT + '/tests/browser_server.py').read().split("if __name__ == '__main__':", 1)[1]
import textwrap
exec(textwrap.dedent(src), {**vars(hs), '__name__': '__main__'})
