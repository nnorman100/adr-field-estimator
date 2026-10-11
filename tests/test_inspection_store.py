from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import pytest
from backend.inspection_store import Conflict,Limited
from backend.claims import make_documents
from backend.contracts import AIResult
from tests.fakes import FakeStore,png
from tests.test_backend import ID,data,sign_payload

def audited(store):
    record=store.create_inspection('owner',ID,data())
    from backend.contracts import InspectionData
    docs=make_documents(InspectionData.model_validate(record['data']),[],AIResult(summary='Confirmed',suggestions=[],unpriced_work=[]))
    return store.save_audit('owner',ID,record['revision'],docs)

def test_revision_conflicts_do_not_overwrite_local_or_remote_work():
    store=FakeStore();record=store.create_inspection('owner',ID,data())
    changed=data();changed['technician_notes']='New observed condition'
    updated=store.update_inspection('owner',ID,record['revision'],changed)
    assert updated['revision']==2
    with pytest.raises(Conflict):store.update_inspection('owner',ID,1,data())
    assert store.get_inspection('owner',ID)['data']==changed
    with pytest.raises(LookupError):store.get_inspection('other',ID)

def test_concurrent_authorization_retries_and_other_identity_are_isolated():
    store=FakeStore();record=audited(store);payload=sign_payload(record)
    with ThreadPoolExecutor(max_workers=4) as pool:
        receipts=list(pool.map(lambda _:store.authorize('owner',payload),range(4)))
    assert all(r==receipts[0] for r in receipts)
    assert len([k for k in store.db.records if k.startswith('authorizations/')])==1
    assert len(store.bucket.objects)==1
    with pytest.raises(LookupError):store.authorize('other',payload)
    changed=deepcopy(payload);changed['signature_png']=png(blank=True)
    with pytest.raises(Conflict):store.authorize('owner',changed)

def test_signature_and_metadata_are_validated_before_upload():
    store=FakeStore();record=audited(store);payload=sign_payload(record);payload['signature_png']=png(blank=True)
    with pytest.raises(ValueError,match='Draw a signature'):store.authorize('owner',payload)
    assert not store.bucket.objects
    too_large=data();too_large['technician_notes']='x'*800001
    with pytest.raises(ValueError):store.create_inspection('owner','ADR-INS-'+'b'*32,too_large)
    assert not store.bucket.objects

def test_photo_retry_same_id_cannot_substitute_room_or_evidence():
    store=FakeStore();record=store.create_inspection('owner',ID,data())
    upload=dict(expected_revision=1,photo_id='b'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png())
    first=store.add_photo('owner',ID,upload)
    assert store.add_photo('owner',ID,upload)==first
    changed={**upload,'room':'Kitchen'}
    with pytest.raises(Conflict):store.add_photo('owner',ID,changed)
    assert len(store.bucket.objects)==1

def test_limits_and_live_lease_apply_across_instances():
    first=FakeStore();second=FakeStore(first.db,first.bucket)
    first.quota('owner','audit',3);second.quota('owner','audit',3);first.quota('owner','audit',3)
    with pytest.raises(Limited):second.quota('owner','audit',3)
    lease=first.live_lease('owner')
    with pytest.raises(Limited):second.live_lease('owner')
    assert second.live_lease('owner',lease)==lease
    first.live_lease('owner',lease,True)
    assert second.live_lease('owner')!=lease

@pytest.mark.parametrize('action,per_minute,per_day',[('ocr',20,400),('audit',3,60),('scope',6,120),('live',None,40)])
def test_daily_ai_caps_outlast_the_minute_window(monkeypatch,action,per_minute,per_day):
    import backend.inspection_store as module
    from types import SimpleNamespace
    clock=[1_000_000.0];monkeypatch.setattr(module,'time',SimpleNamespace(time=lambda:clock[0]))
    store=FakeStore()
    for call in range(per_day):
        if per_minute and call and call%per_minute==0:clock[0]+=61
        store.quota('owner',action,per_minute)
    clock[0]+=61
    with pytest.raises(Limited) as limited:store.quota('owner',action,per_minute)
    assert limited.value.retry_after>3600
    store.quota('owner','draft',60)
    store.quota('other',action,per_minute)
    clock[0]+=86400
    store.quota('owner',action,per_minute)

def test_newest_first_pages_include_every_record_and_reject_other_owner_cursor():
    store=FakeStore()
    for i in range(205):
        stamp=f'2026-10-06T19:{i//60:02}:{i%60:02}Z'
        identifier='ADR-INS-'+f'{i:032x}'
        store.db.records['inspections/'+identifier]=dict(owner_uid='owner',inspection_id=identifier,updated_at=stamp)
        auth_id=f'ADR-AUTH-{i:06}'
        store.db.records['authorizations/'+auth_id]=dict(owner_uid='owner',auth_id=auth_id,created_at=stamp)
    for page_method,id_field in [(store.inspection_page,'inspection_id'),(store.authorization_page,'auth_id')]:
        rows,cursor=page_method('owner');assert len(rows)==100
        assert rows[0][id_field].endswith('000000000000000000000000000000cc' if id_field=='inspection_id' else '000204')
        all_rows=rows[:]
        with pytest.raises(LookupError):page_method('other',cursor)
        while cursor:
            rows,cursor=page_method('owner',cursor);all_rows+=rows
        assert len(all_rows)==205 and len({r[id_field] for r in all_rows})==205

@pytest.mark.parametrize('signature',[False,True])
def test_conflict_after_upload_removes_only_uncommitted_object(signature):
    store=FakeStore();record=audited(store) if signature else store.create_inspection('owner',ID,data())
    original=store.bucket.blob
    fired=False
    def blob(path):
        result=original(path);upload=result.upload_from_string
        def upload_and_edit(*args,**kwargs):
            nonlocal fired
            upload(*args,**kwargs)
            if not fired:
                fired=True;changed=data();changed['technician_notes']='Concurrent edit'
                store.update_inspection('owner',ID,record['revision'],changed)
        result.upload_from_string=upload_and_edit
        return result
    store.bucket.blob=blob
    with pytest.raises(Conflict):
        if signature:store.authorize('owner',sign_payload(record))
        else:store.add_photo('owner',ID,dict(expected_revision=record['revision'],photo_id='b'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png()))
    assert not store.bucket.objects
    assert store.get_inspection('owner',ID)['data']['technician_notes']=='Concurrent edit'
