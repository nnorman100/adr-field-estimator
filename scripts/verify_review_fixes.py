"""Dedicated-project synthetic acceptance; never use customer identities or records."""
import asyncio
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4
import requests

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.verify_migration import PROJECT, URL, access_token, session
from scripts.verify_repairs import SERVICE, check, image

BASE=f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)'
DOCS=f'projects/{PROJECT}/databases/(default)/documents/'
PREFIX='adr-review-smoke-'

def value(v):
    if isinstance(v,bool):return {'booleanValue':v}
    if isinstance(v,int):return {'integerValue':str(v)}
    if isinstance(v,dict):return {'mapValue':{'fields':{k:value(x) for k,x in v.items()}}}
    return {'stringValue':v}

def main():
    bearer=access_token()
    def admin(method,url,body=None):
        response=requests.request(method,url,json=body,headers={'Authorization':'Bearer '+bearer,'x-goog-user-project':PROJECT},timeout=60)
        assert response.ok,f'Synthetic admin request failed: {response.status_code}'
        return response.json() if response.content else {}
    def objects(uid):
        return admin('GET',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o?prefix=users/{uid}/').get('items',[])
    suffix=uuid4().hex[:12];uids=[PREFIX+suffix+'-'+s for s in ('a','b')];created=[];paths=[]
    config=requests.get(URL+'/__/firebase/init.json',timeout=30).json()
    assert config['projectId']==PROJECT
    try:
        tokens=[]
        for uid in uids:
            created.append(uid);tokens.append(session(uid,config['apiKey']))
        token,other=tokens
        check('GET','/api/session',token)
        writes=[]
        for collection,id_field,stamp_field in [('inspections','inspection_id','updated_at'),('authorizations','auth_id','created_at')]:
            for i in range(105):
                identifier=('ADR-INS-' if collection=='inspections' else 'ADR-AUTH-')+suffix+f'-{i:03}'
                path=collection+'/'+identifier;paths.append(path)
                stamp=f'2026-10-06T19:{i//60:02}:{i%60:02}Z'
                fields=dict(owner_uid=uids[1],**{id_field:identifier,stamp_field:stamp},revision=1,status='draft',data={'address':'Synthetic pagination fixture'},address='Synthetic pagination fixture')
                writes.append({'update':{'name':DOCS+path,'fields':{k:value(v) for k,v in fields.items()}},'currentDocument':{'exists':False}})
        admin('POST',BASE+'/documents:commit',{'writes':writes})
        for collection in ('inspections','authorizations'):
            first=check('GET','/api/'+collection,other).json()
            assert len(first[collection])==100 and first['next_cursor']
            field='inspection_id' if collection=='inspections' else 'auth_id'
            assert first[collection][0][field].endswith('-104')
            second=check('GET','/api/'+collection+'?cursor='+first['next_cursor'],other).json()
            assert len(second[collection])==5 and second['next_cursor'] is None
            assert second[collection][-1][field].endswith('-000')
            check('GET','/api/'+collection+'?cursor='+first['next_cursor'],token,expected=404)
        print('PASS: real Firestore newest-first pagination across 105 drafts and 105 signed-job fixtures, and cross-owner cursor denial',flush=True)
        iid='ADR-INS-'+uuid4().hex;paths.append('inspections/'+iid)
        data=dict(address='Synthetic review verification, no customer data',year_built=2000,rooms=[dict(name='Bathroom',category=1,finished_sf=10)],air_movers=3,dehumidifiers=1,drying_days=3,scope_confirmed=True,technician_notes='Localized clean water damage. Proposed removal of 10 SF drywall and drying with the entered three fans and one dehumidifier for three days. No additional work requested.')
        record=check('POST','/api/inspections',token,{'inspection_id':iid,'data':data}).json()
        headers={'Authorization':'Bearer '+token}
        def upload(_):
            return requests.post(SERVICE+'/api/inspections/'+iid+'/photos',headers=headers,json=dict(expected_revision=record['revision'],photo_id=uuid4().hex,room='Bathroom',captured_at='2026-10-07T12:00:00Z',data_url=image()),timeout=60)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(upload,range(2)))
        assert sorted(r.status_code for r in results)==[200,409]
        record=check('GET','/api/inspections/'+iid,token).json()
        assert len(record['photos'])==1 and len(objects(uids[0]))==1
        pid=record['photos'][0]['id']
        check('POST',f'/api/inspections/{iid}/photos/{pid}/ocr',token,{})
        record=check('GET','/api/inspections/'+iid,token).json()
        record=check('POST','/api/audit',token,dict(inspection_id=iid,expected_revision=record['revision'])).json()
        assert record['audit']['documents']['signable'],record['audit']['documents']['unpriced_work']
        aid='ADR-AUTH-'+uuid4().hex;paths.append('authorizations/'+aid)
        payload=dict(inspection_id=iid,expected_revision=record['revision'],auth_id=aid,proposal_hash=record['audit']['proposal_hash'],signature_png=image(True),documents_confirmed=True)
        with ThreadPoolExecutor(max_workers=2) as pool:receipts=list(pool.map(lambda _:check('POST','/api/authorize',token,payload).json(),range(2)))
        assert receipts[0]==receipts[1] and len(objects(uids[0]))==2
        signed=check('GET','/api/authorizations/'+aid,token).json()
        assert signed['documents']==record['audit']['documents']
        check('GET','/api/authorizations/'+aid+'/evidence/signature',token)
        check('GET','/api/authorizations/'+aid+'/evidence/photo-0',token)
        print('PASS: real concurrent photo conflict and signature retries retain only committed objects; four-document/evidence restoration',flush=True)
        live_id='ADR-INS-'+uuid4().hex;paths.append('inspections/'+live_id)
        check('POST','/api/inspections',token,{'inspection_id':live_id,'data':data})
        async def disable_live():
            from websockets.asyncio.client import connect
            async with connect(SERVICE.replace('https:','wss:')+'/api/live',origin=URL) as ws:
                await ws.send(json.dumps({'type':'authenticate','token':token,'inspection_id':live_id}))
                assert json.loads(await asyncio.wait_for(ws.recv(),30))['type']=='ready'
                await asyncio.to_thread(admin,'POST',f'https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:update',{'localId':uids[0],'disableUser':True})
                start=time.monotonic()
                packet=json.loads(await asyncio.wait_for(ws.recv(),35))
                assert packet['type']=='error',packet
                print(f'PASS: real active Gemini Live session stops after account disable ({time.monotonic()-start:.1f}s); target recheck is 20 seconds',flush=True)
        asyncio.run(disable_live())
        check('GET','/api/session',token,expected=401)
        print('PASS: disabled Firebase account rejected on protected REST route',flush=True)
    finally:
        for uid in created:
            paths.extend(['_limits/'+uid,'_live_sessions/'+uid])
        if paths:admin('POST',BASE+'/documents:commit',{'writes':[{'delete':DOCS+p} for p in paths]})
        for uid in created:
            assert uid.startswith(PREFIX)
            for item in objects(uid):admin('DELETE',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o/'+quote(item['name'],safe=''))
            admin('POST',f'https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:delete',{'localId':uid})
        print('Synthetic review accounts, records, leases, quotas and evidence removed',flush=True)

if __name__=='__main__':main()
