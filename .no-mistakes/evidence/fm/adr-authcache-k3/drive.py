"""Drives the real backend (uvicorn) against the Firebase Auth/Firestore emulators and counts
Identity Toolkit accounts:lookup calls (the revoked/disabled-user check) seen by the counting proxy."""
import asyncio, json, sys, time, httpx, websockets
EMU='http://127.0.0.1:19099'; PROJ='alert-disaster-field-2026'; LOG='/tmp/adrk3/lookups.jsonl'
API=sys.argv[1]; MODE=sys.argv[2]
ID='ADR-INS-'+'b'*32
DATA={'address':'Synthetic test property','year_built':1960,'rooms':[{'name':'Bathroom','category':1,'finished_sf':10}],
      'air_movers':3,'dehumidifiers':1,'scope_confirmed':True,'technician_notes':'Localized clean water damage. Proposed drying and drywall removal.'}
def lookups(): return sum(1 for l in open(LOG) if 'accounts:lookup' in l)
def out(*a): print(*a,flush=True)
def user(email):
    k={'key':'fake'}
    r=httpx.post(f'{EMU}/identitytoolkit.googleapis.com/v1/accounts:signUp',params=k,json={'email':email,'password':'Secret123!','returnSecureToken':True}).json()
    uid=r['localId']; admin(uid,emailVerified=True)
    tok=httpx.post(f'{EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',params=k,json={'email':email,'password':'Secret123!','returnSecureToken':True}).json()['idToken']
    return uid,tok
def admin(uid,**fields):
    httpx.post(f'{EMU}/identitytoolkit.googleapis.com/v1/projects/{PROJ}/accounts:update',headers={'Authorization':'Bearer owner'},json={'localId':uid,**fields}).raise_for_status()
def step(label,fn):
    before=lookups(); t=time.time(); r=fn(); ms=round((time.time()-t)*1000)
    status=r if isinstance(r,(int,str)) else r.status_code
    out(f'{label:<62} -> {str(status):<28} revocation lookups +{lookups()-before}  ({ms} ms)')
    return r
async def ws(token,inspection=ID):
    try:
        async with websockets.connect(API.replace('http','ws')+'/api/live',origin='https://alert-disaster-field-2026.web.app',open_timeout=5) as s:
            await s.send(json.dumps({'type':'authenticate','token':token,'inspection_id':inspection}))
            try: m=await asyncio.wait_for(s.recv(),8); return 'message '+json.loads(m).get('type','?')+':'+str(json.loads(m).get('message',''))[:40]
            except websockets.ConnectionClosed as e: return f'closed {e.rcvd.code if e.rcvd else ""} {e.rcvd.reason if e.rcvd else ""}'
    except Exception as e: return f'error {type(e).__name__}'
def live(token): return asyncio.run(ws(token))

if MODE=='core':
    uid,tok=user('tech@example.com'); c=httpx.Client(base_url=API,headers={'Authorization':'Bearer '+tok},timeout=30)
    out('== S1 autosave / reads reuse a passed revocation lookup ==')
    rec=step('POST /api/inspections (first request with this token)',lambda:c.post('/api/inspections',json={'inspection_id':ID,'data':DATA})).json()
    rev=rec['revision']
    for i in range(3):
        r=step(f'PUT  /api/inspections/{{id}} autosave #{i+1}',lambda:c.put('/api/inspections/'+ID,json={'expected_revision':rev,'data':{**DATA,'technician_notes':DATA['technician_notes']+f' Save {i}.'}}))
        rev=r.json()['revision']; time.sleep(1.5)
    step('GET  /api/inspections/{id}',lambda:c.get('/api/inspections/'+ID))
    step('GET  /api/inspections (list)',lambda:c.get('/api/inspections'))
    out('== S2 signing and evidence downloads always look up live ==')
    for i in range(2): step(f'POST /api/authorize #{i+1}',lambda:c.post('/api/authorize',json={'auth_id':'missing'}))
    for i in range(2): step(f'GET  /api/authorizations/missing/evidence/signature #{i+1}',lambda:c.get('/api/authorizations/missing/evidence/signature'))
    out('== S3 Live walkthrough start always looks up live ==')
    step('WS   /api/live authenticate (cached token, active user)',lambda:live(tok))
    out('== S4 disabled user: live routes refuse at once; cached routes within the bound ==')
    admin(uid,disableUser=True); out('   [admin] user disabled in Auth emulator')
    step('PUT  /api/inspections/{id} autosave right after disabling',lambda:c.put('/api/inspections/'+ID,json={'expected_revision':rev,'data':DATA}))
    step('WS   /api/live authenticate after disabling',lambda:live(tok))
    step('POST /api/authorize after disabling',lambda:c.post('/api/authorize',json={'auth_id':'missing'}))
    step('GET  evidence after disabling',lambda:c.get('/api/authorizations/missing/evidence/signature'))
    step('PUT  autosave after a live route refused the token',lambda:c.put('/api/inspections/'+ID,json={'expected_revision':rev,'data':DATA}))
if MODE=='ttl':
    uid,tok=user(sys.argv[3]); c=httpx.Client(base_url=API,headers={'Authorization':'Bearer '+tok},timeout=30)
    step('GET  /api/inspections (first request, lookup recorded)',lambda:c.get('/api/inspections'))
    time.sleep(1.2); admin(uid,validSince=str(int(time.time()))); out(f'   [admin] refresh tokens revoked (validSince=now) at t+0')
    t0=time.time()
    step('GET  /api/inspections right after revocation (cached)',lambda:c.get('/api/inspections'))
    time.sleep(max(0,40-(time.time()-t0)))
    step(f'GET  /api/inspections at t+{round(time.time()-t0)}s (still inside 45 s TTL)',lambda:c.get('/api/inspections'))
    time.sleep(max(0,47-(time.time()-t0)))
    step(f'GET  /api/inspections at t+{round(time.time()-t0)}s (TTL lapsed)',lambda:c.get('/api/inspections'))
    step('GET  /api/inspections again',lambda:c.get('/api/inspections'))
if MODE=='zero':
    uid,tok=user(sys.argv[3]); c=httpx.Client(base_url=API,headers={'Authorization':'Bearer '+tok},timeout=30)
    for i in range(3): step(f'GET  /api/inspections #{i+1} with REVOCATION_CACHE_SECONDS=0',lambda:c.get('/api/inspections'))
if MODE=='workspace':
    uid,tok=user(sys.argv[3]); c=httpx.Client(base_url=API,headers={'Authorization':'Bearer '+tok,'X-ADR-Workspace-Protocol':'1'},timeout=30)
    for i in range(2): step(f'GET  /api/access #{i+1}',lambda:c.get('/api/access'))
    for i in range(2): step(f'GET  /api/admin/companies #{i+1}',lambda:c.get('/api/admin/companies'))
    for i in range(2): step(f'POST /api/invitations/x/accept #{i+1}',lambda:c.post('/api/invitations/missing/accept'))
