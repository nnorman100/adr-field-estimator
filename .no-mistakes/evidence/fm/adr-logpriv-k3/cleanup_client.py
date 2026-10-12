import sys,json,urllib.request
sys.path.insert(0,sys.argv[1]);PORT=sys.argv[2]
from tests.fakes import png
from tests.test_backend import data, ID
def call(method,path,body):
    req=urllib.request.Request(f'http://127.0.0.1:{PORT}{path}',data=json.dumps(body).encode(),method=method,
        headers={'Authorization':'Bearer test-uid-7f3a','Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status,r.read().decode()
    except urllib.error.HTTPError as e: return e.code,e.read().decode()
s,b=call('POST','/api/inspections',{'inspection_id':ID,'data':data()});print('create',s)
rev=json.loads(b)['revision'] if s==200 else 1
st,bd=call('POST',f'/api/inspections/{ID}/photos',dict(expected_revision=rev,photo_id='b'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png()));print('upload',st,bd[:200])
