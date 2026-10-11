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
    def stream(self,transaction=None):
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

from types import SimpleNamespace
from firebase_admin import auth as firebase_auth
class FakeAuth:
    """Firebase Admin auth keyed by email. Reset links carry a recognizable secret so tests can trace where they go."""
    UserNotFoundError=firebase_auth.UserNotFoundError;EmailAlreadyExistsError=firebase_auth.EmailAlreadyExistsError;ActionCodeSettings=firebase_auth.ActionCodeSettings
    def __init__(self):self.users={};self.created=[];self.links=[]
    def add(self,email,*providers):self.users[email]=SimpleNamespace(email=email,email_verified=True,provider_data=[SimpleNamespace(provider_id=p) for p in providers])
    def get_user_by_email(self,email,app=None):
        if email not in self.users:raise self.UserNotFoundError('No user record found.')
        return self.users[email]
    def create_user(self,email,email_verified,app=None):
        if email in self.users:raise self.EmailAlreadyExistsError('The user with the provided email already exists.',None,None)
        self.created.append(dict(email=email,email_verified=email_verified))
        self.users[email]=SimpleNamespace(email=email,email_verified=email_verified,provider_data=[])
        return self.users[email]
    def generate_password_reset_link(self,email,action_code_settings,app=None):
        link='https://alert-disaster-field-2026.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=secret-oob-'+str(len(self.links))
        self.links.append(dict(email=email,url=action_code_settings.url,in_app=action_code_settings.handle_code_in_app,link=link))
        return link
