"""Paid synthetic acceptance checks on the dedicated project; no credentials are logged."""
import asyncio, base64, io, json, sys, time
from pathlib import Path
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
import requests
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts.verify_migration import admin, session, PROJECT, URL

SERVICE='https://alert-disaster-field-estimator-545776254070.us-west2.run.app'
PREFIX='adr-repair-smoke-'

def image(signature=False):
    im=Image.new('RGB',(300,600) if not signature else (400,180),'white')
    draw=ImageDraw.Draw(im)
    if signature:draw.line([(20,110),(100,40),(200,130),(360,45)],fill='black',width=4)
    else:draw.text((20,40),'SYNTHETIC PHOTO - NO METER',fill='black')
    output=io.BytesIO();im.save(output,format='PNG');return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()

def check(method,path,token=None,body=None,expected=200):
    result=requests.request(method,SERVICE+path,json=body,headers={'Authorization':'Bearer '+token} if token else {},timeout=115)
    assert result.status_code==expected,f'{method} {path}: expected {expected}, got {result.status_code}: {result.text[:250]}'
    return result

async def live(token,other,inspection_id):
    from websockets.asyncio.client import connect
    target=SERVICE.replace('https:','wss:')+'/api/live';origin=URL
    async with connect(target,origin=origin) as ws:
        await ws.send(json.dumps({'type':'authenticate','token':other,'inspection_id':inspection_id}))
        assert json.loads(await asyncio.wait_for(ws.recv(),15))['type']=='error'
    async with connect(target,origin=origin) as ws:
        await ws.send(json.dumps({'type':'authenticate','token':token,'inspection_id':inspection_id}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),30));assert ready['type']=='ready',ready
        async with connect(target,origin=origin) as second:
            await second.send(json.dumps({'type':'authenticate','token':token,'inspection_id':inspection_id}))
            assert json.loads(await asyncio.wait_for(second.recv(),15))['type']=='error'
        # Real speech fixture: generated locally via installed Windows speech synthesizer.
        wav=ROOT/'review-artifacts/live-prompt.wav'
        import wave
        with wave.open(str(wav),'rb') as recording:
            pcm=recording.readframes(recording.getnframes());width=recording.getsampwidth();rate=recording.getframerate()
            assert recording.getnchannels()==1 and width==2 and rate==16000,'Use the 16 kHz mono speech fixture'
        start=time.monotonic()
        for offset in range(0,len(pcm),3200):
            await ws.send(json.dumps({'type':'audio','data':base64.b64encode(pcm[offset:offset+3200]).decode()}));await asyncio.sleep(.1)
        speech_end=time.monotonic()
        for _ in range(8):await ws.send(json.dumps({'type':'audio','data':base64.b64encode(b'\0'*3200).decode()}));await asyncio.sleep(.1)
        audio_bytes=0;transcripts=[];first=None
        until=time.monotonic()+35
        while time.monotonic()<until:
            packet=json.loads(await asyncio.wait_for(ws.recv(),max(1,until-time.monotonic())))
            if packet['type']=='audio':
                assert packet['rate']==24000;audio_bytes+=len(base64.b64decode(packet['data']));first=first or time.monotonic()
            if packet['type']=='transcript':transcripts.append(packet['speaker'])
            if packet['type']=='turn_complete' and audio_bytes:break
            assert packet['type']!='error',packet
        assert audio_bytes>0 and 'assistant' in transcripts
        print(f'PASS: real authenticated Gemini Live relay, {audio_bytes} PCM output bytes, separate transcripts, one-session lease. Observed first-read delay {first-speech_end:.2f}s (includes receive scheduling; not device latency).',flush=True)
        await ws.send(json.dumps({'type':'end'}))
    await asyncio.sleep(1)
    async with connect(target,origin=origin) as ws:
        await ws.send(json.dumps({'type':'authenticate','token':token,'inspection_id':inspection_id}))
        assert json.loads(await asyncio.wait_for(ws.recv(),30))['type']=='ready'
        await ws.send(json.dumps({'type':'end'}))
    print('PASS: Live ownership denial and disconnect/reconnect lease cleanup',flush=True)

def main():
    config=requests.get(URL+'/__/firebase/init.json',timeout=30).json();assert config['projectId']==PROJECT
    health=check('GET','/api/health').json();assert health['schema_version']==3 and health['audit_model']=='gemini-3.8-flash'
    check('GET','/api/inspections',expected=401)
    suffix=uuid4().hex[:12];uids=[PREFIX+suffix+x for x in ('-a','-b','-unapproved')];created=[];records=[];auths=[]
    try:
        tokens=[]
        for index,uid in enumerate(uids):tokens.append(session(uid,config['apiKey'],index<2));created.append(uid)
        token,other,unapproved=tokens
        check('GET','/api/session',unapproved,expected=403)
        iid='ADR-INS-'+uuid4().hex;records.append(iid)
        data=dict(address='Synthetic repair verification, no customer data',year_built=1960,has_crawl_space=True,
                  rooms=[dict(name='Bathroom',category=1,finished_sf=10,unfinished_sf=0,custom_cabinetry=False,waste_percent=10)],
                  air_movers=3,dehumidifiers=1,drying_days=3,labor_hours=0,is_after_hours=False,
                  technician_notes='Localized clean water damage. Proposed drywall removal and drying only.',scope_confirmed=True)
        record=check('POST','/api/inspections',token,dict(inspection_id=iid,data=data)).json()
        check('GET','/api/inspections/'+iid,other,expected=404)
        check('PUT','/api/inspections/'+iid,token,dict(expected_revision=999,data=data),expected=409)
        pid=uuid4().hex
        record=check('POST','/api/inspections/'+iid+'/photos',token,dict(expected_revision=record['revision'],photo_id=pid,room='Bathroom',captured_at='2026-10-06T20:00:00Z',data_url=image())).json()
        assert record['photos'][0]['width']==300 and record['photos'][0]['height']==600
        check('GET',f'/api/inspections/{iid}/photos/{pid}',other,expected=404)
        record=check('POST',f'/api/inspections/{iid}/photos/{pid}/ocr',token,{}).json();assert record['photos'][0]['ocr_status']=='no_meter'
        asyncio.run(live(token,other,iid))
        record=check('POST','/api/audit',token,dict(inspection_id=iid,expected_revision=record['revision'])).json();docs=record['audit']['documents']
        assert docs['signable'],docs['unpriced_work']
        assert docs['xactimate_total']==1777.78
        assert docs['adr_estimate']['proposed_cost_low']==1777.78 and docs['adr_estimate']['proposed_cost']==1793.07
        assert sum(item['total'] for item in docs['xactimate_scope'][:5])==1180.2
        assert '(this does not include the pretest for lead/asbestos)' in docs['adr_estimate']['disclaimers']
        assert docs['photo_audit_log'][0]['ocr_status']=='no_meter'
        print('PASS: real dedicated OCR/audit, exact baseline/equipment/waste, sheet-derived estimate range, age/crawl wording and truthful portrait evidence',flush=True)
        aid='ADR-AUTH-'+uuid4().hex;auths.append(aid)
        payload=dict(inspection_id=iid,expected_revision=record['revision'],auth_id=aid,proposal_hash=record['audit']['proposal_hash'],signature_png=image(True),documents_confirmed=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:check('POST','/api/authorize',token,payload).json(),range(2)))
        assert results[0]==results[1]
        signed=check('GET','/api/authorizations/'+aid,token).json();assert signed['documents']==docs
        check('GET','/api/authorizations/'+aid,other,expected=404)
        check('GET','/api/authorizations/'+aid+'/evidence/signature',token)
        check('GET','/api/authorizations/'+aid+'/evidence/photo-0',token)
        check('PUT','/api/inspections/'+iid,token,dict(expected_revision=record['revision'],data=data),expected=409)
        assert requests.get('https://storage.googleapis.com/'+PROJECT+'-evidence/'+signed['signature']['path'],timeout=30).status_code in (401,403)
        assert requests.get(URL+'/api/health',timeout=30).json()['schema_version']==3
        print('PASS: concurrent identical signing receipts, immutable complete restoration, private evidence and owner isolation',flush=True)
    finally:
        for collection,ids in [('authorizations',auths),('inspections',records),('_limits',created),('_live_sessions',created)]:
            for identifier in ids:
                response=requests.delete(f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{collection}/{identifier}',headers={'Authorization':'Bearer '+__import__('scripts.verify_migration',fromlist=['access_token']).access_token(),'x-goog-user-project':PROJECT},timeout=30)
                assert response.status_code in (200,404),f'Cleanup {collection} failed'
        from urllib.parse import quote
        for uid in created:
            assert uid.startswith(PREFIX)
            for item in admin('GET',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o?prefix=users/{uid}/').get('items',[]):admin('DELETE',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o/{quote(item["name"],safe="")}')
            admin('POST',f'https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:delete',{'localId':uid})
        print('Synthetic repair records, accounts, quotas, leases and evidence removed',flush=True)

if __name__=='__main__':main()
