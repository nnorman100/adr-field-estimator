"""Disposable wrapper: the repo's local synthetic harness, plus a synthetic Live token verifier
and a Vertex stand-in that only reports the gate was passed. No cloud access."""
import os, sys, runpy
ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import backend.main as bm

async def verify_identity(token, live=False):
    if not token.startswith('test-owner-'):
        raise bm.HTTPException(401, 'Sign in to continue.')
    return dict(uid=token, email=token + '@example.invalid', email_verified=True,
                firebase={'sign_in_provider': 'google.com'}, exp=9e12)
bm.verify_identity = verify_identity

class GatePassed(RuntimeError):
    pass
def client(**kwargs):
    raise GatePassed('SYNTHETIC: workspace gate passed; would connect to Vertex now')
bm.genai.Client = client
sys.argv = [os.path.join(ROOT, 'tests/browser_server.py')]
runpy.run_path(sys.argv[0], run_name='__main__')
