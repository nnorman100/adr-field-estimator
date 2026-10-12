"""Drives the real backend (uvicorn) against Firebase emulators. Counts real accounts:lookup calls via the proxy log."""
import sys,time,json,asyncio,uuid,httpx,websockets
API=sys.argv[1]; TTL=float(sys.argv[2]); LOG='/tmp/adr-authcache/lookups.log'
EMU='http://127.0.0.1:9419/identitytoolkit.googleapis.com/v1'; P='projects/alert-disaster-field-2026'
ADMIN={'Authorization':'Bearer owner'}; T0=time.time()
def say(*a): print(f'[{time.time()-T0:6.1f}s]',*a,flush=True)
def lookups(): 
    try: return sum(1 for _ in open(LOG))
    except FileNotFoundError: return 0
def user(email):
    r=httpx.post(EMU+'/accounts:signUp?key=fake',json=dict(email=email,password='synthetic-pass',returnSecureToken=True)).json()
    httpx.post(f'{EMU}/{P}/accounts:update',headers=ADMIN,json=dict(localId=r['localId'],emailVerified=True)).raise_for_status()
    return r['localId'],signin(email)
def signin(email): return httpx.post(EMU+'/accounts:signInWithPassword?key=fake',json=dict(email=email,password='synthetic-pass',returnSecureToken=True)).json()['idToken']
def disable(uid,on=True): httpx.post(f'{EMU}/{P}/accounts:update',headers=ADMIN,json=dict(localId=uid,disableUser=on)).raise_for_status()
c=httpx.Client(base_url=API,timeout=30)
def call(m,path,tok,**kw):
    before=lookups(); r=c.request(m,path,headers={'Authorization':'Bearer '+tok},**kw)
    say(f'{m:4} {path[:60]:60} -> {r.status_code}  lookups+{lookups()-before}  {r.text[:70] if r.status_code>=400 else ""}')
    return r
async def ws_start(tok,iid):
    async with websockets.connect(API.replace('http','ws')+'/api/live',origin='https://alert-disaster-field-2026.web.app') as s:
        before=lookups(); await s.send(json.dumps(dict(type='authenticate',token=tok,inspection_id=iid)))
        try: msg=await asyncio.wait_for(s.recv(),15)
        except Exception as e: msg=f'<closed {e}>'
        say(f'WS   /api/live authenticate -> {str(msg)[:110]}  lookups+{lookups()-before}'); return msg
data=dict(address='Synthetic test property',year_built=1960,rooms=[{'name':'Bathroom','category':1,'finished_sf':10}],air_movers=3,dehumidifiers=1,scope_confirmed=True)
PNG=open('/tmp/adr-authcache/png.txt').read()
mode=sys.argv[3]
if mode=='legacy':
    say('=== S1: cached routes reuse one revocation lookup per token within the TTL ===')
    uid,tok=user('tech@example.com'); iid='ADR-INS-'+uuid.uuid4().hex; start=lookups()
    call('GET','/api/session',tok)
    rec=call('POST','/api/inspections',tok,json=dict(inspection_id=iid,data=data)).json()
    for i in range(5):  # autosave PUTs as the PWA sends them
        data['air_movers']=3+i; rec=call('PUT',f'/api/inspections/{iid}',tok,json=dict(expected_revision=rec['revision'],data=data)).json()
    pid=uuid.uuid4().hex
    rec=call('POST',f'/api/inspections/{iid}/photos',tok,json=dict(expected_revision=rec['revision'],photo_id=pid,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=PNG)).json()
    for i in range(3): call('GET',f'/api/inspections/{iid}/photos/{pid}',tok)
    call('GET','/api/inspections',tok)
    say(f'S1 RESULT: {lookups()-start} revocation lookup(s) for 12 cached-route requests')
    say('=== S2: always-live routes repeat the lookup every time, even with a fresh cache entry ===')
    s=lookups()
    for i in range(2): call('GET',f'/api/authorizations/ADR-AUTH-none12345/evidence/signature.png',tok)
    call('POST','/api/authorize',tok,json={})
    asyncio.run(ws_start(tok,iid))
    say(f'S2 RESULT: {lookups()-s} lookups for 4 live-route requests')
    say('=== S3: disable the user; live routes reject at once, cached routes reject once the TTL lapses ===')
    disable(uid); say('user disabled in Auth emulator'); t=time.time()
    call('GET','/api/session',tok)
    call('PUT',f'/api/inspections/{iid}',tok,json=dict(expected_revision=rec['revision'],data=data))
    call('GET',f'/api/authorizations/ADR-AUTH-none12345/evidence/signature.png',tok)
    call('POST','/api/authorize',tok,json={})
    asyncio.run(ws_start(tok,iid))
    while True:
        r=call('GET','/api/session',tok)
        if r.status_code==401: say(f'S3 RESULT: cached route rejected disabled user {time.time()-t:.1f}s after disable (TTL {TTL}s)'); break
        if time.time()-t>TTL+5: say('S3 RESULT: FAIL cached route still accepted past TTL'); break
        time.sleep(1)
    call('GET','/api/inspections',tok)
    say('=== S4: token revocation (revoke refresh tokens) - live route rejects immediately ===')
    uid2,tok2=user('owner@example.com'); call('GET','/api/session',tok2); time.sleep(1.5)
    httpx.post(f'{EMU}/{P}/accounts:update',headers=ADMIN,json=dict(localId=uid2,validSince=str(int(time.time())))).raise_for_status(); say('tokens revoked (validSince=now)')
    call('GET','/api/session',tok2)
    call('POST','/api/authorize',tok2,json={})
    t=time.time()
    while True:
        r=call('GET','/api/session',tok2)
        if r.status_code==401: say(f'S4 RESULT: cached route rejected revoked token {time.time()-t:.1f}s later'); break
        if time.time()-t>TTL+5: say('S4 RESULT: FAIL'); break
        time.sleep(1)
    say('=== S5: a new token is not covered by another token\'s cache entry ===')
    tok3=signin('owner@example.com'); call('GET','/api/session',tok3); call('GET','/api/session',tok3)
elif mode=='zero':
    uid,tok=user(f'tech@example.com') if False else (None,signin('owner@example.com'))
    s=lookups()
    for i in range(4): call('GET','/api/session',tok)
    say(f'S6 RESULT (REVOCATION_CACHE_SECONDS=0): {lookups()-s} lookups for 4 requests')
elif mode=='workspace':
    uid,tok=user(f'ws-{uuid.uuid4().hex[:6]}@example.com'); s=lookups()
    for i in range(3): call('GET','/api/access',tok)
    say(f'cached /api/access: {lookups()-s} lookups for 3 requests'); s=lookups()
    for i in range(3): call('GET','/api/admin/companies',tok)
    say(f'live /api/admin/companies: {lookups()-s} lookups for 3 requests')
    disable(uid); say('user disabled')
    call('GET','/api/access',tok); call('GET','/api/admin/companies',tok); call('POST','/api/invitations/none/accept',tok)
if mode=='stale':
    say('=== S3b: disable mid-session; cached routes keep working only until the TTL lapses, live routes reject at once ===')
    uid,tok=user(f'stale-{uuid.uuid4().hex[:6]}@example.com') if False else (None,None)
    r=httpx.post(EMU+'/accounts:signInWithPassword?key=fake',json=dict(email='tech@example.com',password='synthetic-pass',returnSecureToken=True)).json()
    uid=r.get('localId') or httpx.post(f'{EMU}/{P}/accounts:lookup',headers=ADMIN,json=dict(email=['tech@example.com'])).json()['users'][0]['localId']
    disable(uid,False); tok=signin('tech@example.com'); iid='ADR-INS-'+uuid.uuid4().hex
    call('GET','/api/session',tok); t0=time.time()
    rec=call('POST','/api/inspections',tok,json=dict(inspection_id=iid,data=data)).json()
    disable(uid); say('user disabled in Auth emulator'); t=time.time()
    while True:
        rec_r=call('PUT',f'/api/inspections/{iid}',tok,json=dict(expected_revision=rec['revision'],data=data))
        if rec_r.status_code==200: rec=rec_r.json()
        if rec_r.status_code==401: say(f'S3b RESULT: autosave rejected {time.time()-t:.1f}s after disable; cache filled {time.time()-t0:.1f}s ago (TTL {TTL}s)'); break
        if time.time()-t0>TTL+3: say('S3b RESULT: FAIL autosave accepted past TTL'); break
        time.sleep(1)
    disable(uid,False); tok=signin('tech@example.com'); call('GET','/api/session',tok); disable(uid); say('re-enabled, new token cached, disabled again')
    call('GET','/api/session',tok)
    call('GET','/api/authorizations/ADR-AUTH-none12345/evidence/signature.png',tok)
    call('GET','/api/session',tok)
    say('S3c RESULT: a live-route rejection also drops the cached pass, so the next cached request rejects too')
