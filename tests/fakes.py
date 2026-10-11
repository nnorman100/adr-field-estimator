from copy import deepcopy
from threading import RLock
import io, base64
from PIL import Image, ImageDraw
from google.api_core.exceptions import AlreadyExists
from backend.inspection_store import InspectionStore

def png(blank=False):
    image=Image.new('RGBA',(120,60),(255,255,255,0))
    if not blank: ImageDraw.Draw(image).line([(10,35),(40,12),(65,40),(105,15)],fill=(0,0,0,255),width=3)
    output=io.BytesIO();image.save(output,format='PNG')
    return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()

class Snapshot:
    def __init__(self,value):self.value=deepcopy(value);self.exists=value is not None
    def to_dict(self):return deepcopy(self.value)
class Ref:
    def __init__(self,db,key):self.db=db;self.key=key
    def get(self,transaction=None):return Snapshot(self.db.records.get(self.key))
    def create(self,value):
        if self.key in self.db.records:raise AlreadyExists('exists')
        self.db.records[self.key]=deepcopy(value)
class Collection:
    def __init__(self,db,name):self.db=db;self.name=name;self.filters=[];self.maximum=100;self.order=None;self.cursor=None
    def document(self,key):return Ref(self.db,self.name+'/'+key)
    def where(self,*,filter):self.filters.append(filter);return self
    def limit(self,maximum):self.maximum=maximum;return self
    def order_by(self,field,direction):self.order=field;return self
    def start_after(self,snapshot):self.cursor=snapshot.to_dict();return self
    def stream(self):
        rows=[v for k,v in self.db.records.items() if k.startswith(self.name+'/') and all((f.value in v.get(f.field_path,[]) if f.op_string=='array_contains' else v.get(f.field_path)==f.value) for f in self.filters)]
        if self.order:rows.sort(key=lambda r:(r[self.order],r.get('job_id',r.get('inspection_id',r.get('auth_id','')))),reverse=True)
        if self.cursor:
            key=lambda r:(r[self.order],r.get('inspection_id',r.get('auth_id','')))
            rows=[r for r in rows if key(r)<key(self.cursor)]
        return iter(Snapshot(r) for r in rows[:self.maximum])
class DB:
    def __init__(self):self.records={};self.lock=RLock()
    def collection(self,name):return Collection(self,name)
class Tx:
    def create(self,ref,value):ref.create(value)
    def set(self,ref,value,merge=False):
        if merge:ref.db.records.setdefault(ref.key,{}).update(deepcopy(value))
        else:ref.db.records[ref.key]=deepcopy(value)
    def update(self,ref,value):ref.db.records[ref.key].update(deepcopy(value))
    def delete(self,ref):ref.db.records.pop(ref.key,None)
class Blob:
    def __init__(self,bucket,key):self.bucket=bucket;self.key=key;self.name=key;self.generation=1
    def upload_from_string(self,raw,content_type,**kwargs):self.bucket.objects[self.key]=(raw,content_type)
    def download_as_bytes(self):return self.bucket.objects[self.key][0]
    def delete(self,**kwargs):self.bucket.objects.pop(self.key,None)
class Bucket:
    def __init__(self):self.objects={}
    def blob(self,key):return Blob(self,key)
class FakeStore(InspectionStore):
    def __init__(self,db=None,bucket=None):super().__init__(db or DB(),bucket or Bucket())
    def _atomic(self,callback):
        with self.db.lock:return callback(Tx())

from backend.company_store import CompanyInspectionStore
class FakeCompanyStore(CompanyInspectionStore):
    def __init__(self,db=None,bucket=None):super().__init__(db or DB(),bucket or Bucket())
    def _atomic(self,callback):
        with self.db.lock:return callback(Tx())
