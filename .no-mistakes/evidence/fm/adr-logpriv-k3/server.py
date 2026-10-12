"""Disposable harness: runs the real backend.main FastAPI app under uvicorn with fake cloud adapters."""
import os,sys
ROOT=sys.argv[1];PORT=int(sys.argv[2])
sys.path.insert(0,ROOT)
import uvicorn
from fastapi import Request,HTTPException
import backend.main as bm
from tests.fakes import FakeStore, Blob
from tests.test_backend import data, ID
store=FakeStore()
async def identity(request:Request):
    token=request.headers.get('Authorization','')
    if not token.startswith('Bearer test-'):raise HTTPException(401,'Sign in to continue.')
    uid=token.split(' ',1)[1][5:]
    return {'uid':uid,'email':'synthetic@example.invalid','email_verified':True,'firebase':{'sign_in_provider':'google.com'}}
bm.app.dependency_overrides[bm.current_staff]=identity
bm.app.dependency_overrides[bm.get_job_store]=lambda:store
if os.getenv('BODY_READ_SECONDS'): bm.BODY_READ_SECONDS=float(os.environ['BODY_READ_SECONDS'])
if os.getenv('FAIL_CLEANUP'):
    def lost(*a,**k): raise RuntimeError('Commit response lost.')
    def refused(blob,**k): raise PermissionError(f'403 DELETE gs://alert-disaster-field-2026-evidence/{blob.name}')
    store._change=lost; Blob.delete=refused
uvicorn.run(bm.app,host='127.0.0.1',port=PORT,log_level='warning')
