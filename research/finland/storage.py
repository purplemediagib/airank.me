"""Private Bunny Storage backup adapter; explicit setup only, no import-time I/O."""
import hashlib,json,os,pathlib,re
from urllib.request import Request,build_opener
from urllib.error import HTTPError
from adapters import NoRedirect
ALLOWED={'storage.bunnycdn.com','uk.storage.bunnycdn.com','se.storage.bunnycdn.com'}
class StorageError(RuntimeError):pass
class BunnyBackup:
    def __init__(self,host,zone,key,study_id,transport=None):
        if host not in ALLOWED:raise StorageError('Storage endpoint must be an approved European Bunny endpoint')
        if not all(re.fullmatch(r'[A-Za-z0-9_-]+',x or '') for x in (zone,study_id)) or not key:raise StorageError('Explicit zone, study identity and storage credential required')
        self.base=f'https://{host}/{zone}/{study_id}/';self.key=key;self.transport=transport or self.http
    def http(self,method,url,data=None):
        headers={'AccessKey':self.key}
        if data is not None:headers.update({'Content-Type':'application/octet-stream','Checksum':hashlib.sha256(data).hexdigest().upper()})
        try:
            with build_opener(NoRedirect).open(Request(url,data,headers,method=method),timeout=60) as r:return r.status,r.read()
        except HTTPError as e:
            if e.code==404 and method=='GET':return 404,b''
            raise StorageError('Storage request rejected; no credential/body logged') from None
        except Exception:raise StorageError('Storage request failed; no credential/body logged') from None
    def put_verified(self,name,data):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',name):raise StorageError('Unsafe artifact name')
        status,existing=self.transport('GET',self.base+name)
        if status==200:
            if existing!=data:raise StorageError('Immutable remote artifact differs')
        elif status==404:
            status,_=self.transport('PUT',self.base+name,data)
            if status!=201:raise StorageError('Backup upload not acknowledged')
        else:raise StorageError('Remote existence check failed')
        status,readback=self.transport('GET',self.base+name)
        digest=hashlib.sha256(data).hexdigest()
        if status!=200 or hashlib.sha256(readback).hexdigest()!=digest:raise StorageError('Backup readback mismatch')
        return {'verified':True,'sha256':digest,'reference':self.base+name}
    def read_marker(self):
        status,data=self.transport('GET',self.base+'study-marker.json')
        if status==404:return None
        if status!=200:raise StorageError('Remote marker cannot be checked')
        try:return json.loads(data)
        except ValueError:raise StorageError('Remote marker corrupt') from None
    def ensure_marker(self,identity):
        prior=self.read_marker()
        if prior is not None and prior!=identity:raise StorageError('Remote identity differs; manual restore required')
        return self.put_verified('study-marker.json',json.dumps(identity,sort_keys=True).encode())
    def create_marker(self,identity):
        status,_=self.transport('GET',self.base+'study-marker.json')
        if status!=404:raise StorageError('Remote study already exists or cannot be checked; never reset budget')
        return self.put_verified('study-marker.json',json.dumps(identity,sort_keys=True).encode())
    def verify_marker(self,study_id):
        status,data=self.transport('GET',self.base+'study-marker.json')
        if status!=200:raise StorageError('Remote study marker absent')
        try:identity=json.loads(data)
        except ValueError:raise StorageError('Remote marker corrupt') from None
        if identity.get('study_id')!=study_id or identity.get('provider_cap_micro_usd')!=38_000_000:raise StorageError('Remote marker identity mismatch')
    def __call__(self,path,digest):
        data=pathlib.Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest()!=digest:raise StorageError('Local backup hash mismatch')
        return self.put_verified(pathlib.Path(path).name,data)

def from_env(study_id):
    return BunnyBackup(os.environ.get('RESEARCH_STORAGE_HOST',''),os.environ.get('RESEARCH_STORAGE_ZONE',''),os.environ.get('RESEARCH_STORAGE_ACCESS_KEY',''),study_id)
