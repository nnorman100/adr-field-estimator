"""Runs the repository's tests/browser_server.py unchanged, but when the notes contain
ADVERSARIAL the fake model also returns hostile claim_changes so the real server-side
grounding is exercised end to end. All other generations delegate to the original fake."""
import json, runpy, sys
from types import SimpleNamespace
import uvicorn

ROOT = sys.argv[1]
real_run = uvicorn.run
QUOTES = {
    'carrier': ('Synthetic Mutual', 'Carrier is Synthetic Mutual.'),
    'policy_number': ('HO-778899', 'Policy HO-778899 is the homeowner policy.'),
    'date_of_loss': ('2026-10-12', 'Loss happened on October 12, 2026.'),
    'loss_cause': ('supply line under kitchen sink', 'Cause was the supply line under kitchen sink.'),
    'adjuster_name': ('Avery Quinn', 'Adjuster is Avery Quinn.'),
    # Hostile: truncated / mismatched values that must NOT be saved.
    'claim_number': ('0042-77', 'Claim number is clm 0042 77.'),
    'adjuster_email': ('avery@example.com', 'Adjuster email is avery@example.com.au.'),
    'adjuster_phone': ('123-4567', 'Policy number HO-123-4567.'),
    'deductible': ('$5', 'The deductible is $5 thousand.'),
}
NOTES = 'Room 1, category 2, 80 square feet of drywall. Use 3 fans. ' + ' '.join(q for _, q in QUOTES.values()) + ' ADVERSARIAL'

def patched_run(app, **kw):
    import backend.main as bm
    original = bm.get_ai_client()
    async def generate(**kwargs):
        res = await original.aio.models.generate_content(**kwargs)
        schema = kwargs['config'].response_schema
        if isinstance(schema, dict) and schema == bm.scope_response_schema() and 'ADVERSARIAL' in str(kwargs['contents']):
            body = json.loads(res.text)
            body['claim_changes'] = [
                {'field': f, 'value': v, 'source_quote': q} for f, (v, q) in QUOTES.items()
            ]
            return SimpleNamespace(text=json.dumps(body))
        return res
    bm.get_ai_client = lambda: SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    return real_run(app, **kw)

if __name__ == '__main__' and len(sys.argv) > 2 and sys.argv[2] == 'notes':
    print(NOTES); sys.exit()
uvicorn.run = patched_run
sys.argv = [ROOT + '/tests/browser_server.py']
runpy.run_path(ROOT + '/tests/browser_server.py', run_name='__main__')
