"""Private Bunny Storage backup adapter; explicit setup only, no import-time I/O."""
import hashlib,json,os,pathlib,re,sqlite3,tempfile
from urllib.request import Request,build_opener
from urllib.error import HTTPError
from adapters import NoRedirect
ALLOWED={'storage.bunnycdn.com','uk.storage.bunnycdn.com','se.storage.bunnycdn.com'}
LAST_STAGE='not_started'
def stage(value):
    global LAST_STAGE
    LAST_STAGE=value

class StorageError(RuntimeError):
    def __init__(self,message,http_status=None,operation=None):
        super().__init__(message)
        self.http_status=http_status if type(http_status) is int and 100<=http_status<=599 else None
        self.operation=operation if operation in ('GET','PUT') else None
class BunnyBackup:
    delete_local_after_verified=True
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
            raise StorageError('Storage request rejected; no credential/body logged',e.code,method) from None
        except Exception:raise StorageError('Storage request failed; no credential/body logged') from None
    def put_verified(self,name,data):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',name):raise StorageError('Unsafe artifact name')
        stage('artifact_existence_get')
        status,existing=self.transport('GET',self.base+name)
        if status==200:
            if existing!=data:raise StorageError('Immutable remote artifact differs')
        elif status==404:
            stage('artifact_put')
            status,_=self.transport('PUT',self.base+name,data)
            if status!=201:raise StorageError('Backup upload not acknowledged')
        else:raise StorageError('Remote existence check failed')
        stage('artifact_readback_get')
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
    def ledger_fingerprint(self,root):
        path=pathlib.Path(root)/'ledger.sqlite'
        if not path.exists():raise StorageError('Ledger missing for remote-head verification')
        with sqlite3.connect(path) as db:data='\n'.join(db.iterdump()).encode()
        return hashlib.sha256(data).hexdigest()
    def head(self):
        stage('head_get')
        status,data=self.transport('GET',self.base+'latest-backup.json')
        if status==404:return None
        if status!=200:raise StorageError('Remote head unavailable')
        try:return json.loads(data)
        except ValueError:raise StorageError('Remote head corrupt') from None
    def verify_head(self,root):
        root=pathlib.Path(root);head=self.head()
        try:local=json.loads((root/'remote-head.json').read_text())
        except (FileNotFoundError,ValueError):raise StorageError('Local backup head missing; manual restore verification required') from None
        if head!=local or head.get('ledger_fingerprint')!=self.ledger_fingerprint(root):raise StorageError('Stale/restored ledger differs from latest remote state; manual reconciliation required')
    def advance_head(self,root,ack,initial=False):
        root=pathlib.Path(root);prior=self.head()
        try:local=json.loads((root/'remote-head.json').read_text())
        except FileNotFoundError:local=None
        if prior!=local or (prior is None and not initial):raise StorageError('Remote/local head mismatch; never overwrite unknown newer state')
        head={'sequence':(prior['sequence']+1 if prior else 1),'archive':ack['reference'],'sha256':ack['sha256'],'ledger_fingerprint':self.ledger_fingerprint(root)}
        data=json.dumps(head,sort_keys=True).encode()
        stage('head_put')
        status,_=self.transport('PUT',self.base+'latest-backup.json',data)
        if status!=201 or self.head()!=head:raise StorageError('Latest backup pointer not verified')
        persist_local_head(root,data)
        return head
    def __call__(self,path,digest):
        data=pathlib.Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest()!=digest:raise StorageError('Local backup hash mismatch')
        ack=self.put_verified(pathlib.Path(path).name,data)
        self.advance_head(pathlib.Path(path).parent.parent,ack,initial=pathlib.Path(path).name.startswith('initial-'))
        return ack


# Explicitly scoped to the reviewed 31-Oct checkpoint incident, not general reset/recovery.
RECOVERY_SEQUENCE=31
RECOVERY_ARCHIVE_SHA256='928eacc929719bd300ae3a71c6447dd6491384a885c85af99910f7baf021774f'
RECOVERY_LEDGER_SHA256='40e88820451bbe0ed5fe550e731a25bbdf66ecf382b73f9f63b50d64e06cd3c5'
RECOVERY_ARCHIVE_NAME='d67e75e72f262389e1403a4dabf49d048a93a87c9147d1dcc4ae6c49974b8276-finished.tar.gz'

def persist_local_head(root,data):
    """Atomic local metadata only; retain prior pointer until fsync+replace succeeds."""
    root=pathlib.Path(root);stage('local_head_persist')
    fd,name=tempfile.mkstemp(prefix='remote-head-reconcile-',suffix='.tmp',dir=root)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(name,root/'remote-head.json')
        directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)


def snapshot_fingerprint(root):
    """Caller holds writer locks; never open the live SQLite database."""
    import shutil
    root=pathlib.Path(root)
    with tempfile.TemporaryDirectory(prefix='research-ledger-read-') as temp:
        target=pathlib.Path(temp)
        for name in ('ledger.sqlite','ledger.sqlite-wal','ledger.sqlite-shm'):
            if (root/name).is_file():shutil.copyfile(root/name,target/name)
        if not (target/'ledger.sqlite').is_file():raise StorageError('Live ledger absent')
        with sqlite3.connect(target/'ledger.sqlite') as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise StorageError('Live ledger integrity failure')
            return hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()

def reconcile_checkpoint(root,remote,study_id):
    """Caller holds both existing locks. No remote writes, ledger writes or provider calls."""
    import io,tarfile
    root=pathlib.Path(root)
    stage('recovery_marker_get');remote.verify_marker(study_id)
    identity=json.loads((root/'identity.json').read_text())
    if identity.get('study_id')!=study_id or identity.get('provider_cap_micro_usd')!=38000000:raise StorageError('Recovery identity mismatch')
    stage('recovery_head_get');head=remote.head()
    expected={'sequence':RECOVERY_SEQUENCE,'sha256':RECOVERY_ARCHIVE_SHA256,'ledger_fingerprint':RECOVERY_LEDGER_SHA256,'archive':remote.base+RECOVERY_ARCHIVE_NAME}
    if head!=expected:raise StorageError('Recovery is limited to reviewed checkpoint')
    prior_bytes=(root/'remote-head.json').read_bytes();prior=json.loads(prior_bytes)
    if prior!=head and (type(prior.get('sequence')) is not int or prior['sequence']!=RECOVERY_SEQUENCE-1):raise StorageError('Unexpected prior local checkpoint')
    stage('recovery_archive_get')
    status,payload=remote.transport('GET',head['archive'])
    if status!=200 or len(payload)>20_000_000 or hashlib.sha256(payload).hexdigest()!=head['sha256']:raise StorageError('Recovery archive checksum differs')
    stage('recovery_archive_validate')
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as tar:
        members=tar.getmembers();files={}
        if sum(x.size for x in members)>40_000_000:raise StorageError('Recovery archive exceeds bound')
        for item in members:
            path=pathlib.PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or item.issym() or item.islnk():raise StorageError('Unsafe recovery archive')
            if item.isfile():
                if item.name in files:raise StorageError('Duplicate recovery archive path')
                files[item.name]=tar.extractfile(item).read()
        archived_identity=json.loads(files['identity.json'])
        if archived_identity!=identity:raise StorageError('Archived study identity differs')
        with tempfile.TemporaryDirectory(prefix='research-recovery-verify-') as temp:
            dbpath=pathlib.Path(temp)/'ledger.sqlite';dbpath.write_bytes(files['ledger.sqlite'])
            with sqlite3.connect(dbpath) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise StorageError('Archived ledger integrity failure')
                fingerprint=hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()
                if fingerprint!=head['ledger_fingerprint']:raise StorageError('Archived ledger fingerprint differs')
                if db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone():raise StorageError('Archived ledger halted')
                if db.execute("SELECT 1 FROM attempts a LEFT JOIN accounting b ON b.attempt_id=a.id WHERE a.status='reserved' OR (a.actual IS NULL AND b.accounted IS NULL)").fetchone():raise StorageError('Unresolved archived attempt')
                rows=db.execute('SELECT raw FROM attempts').fetchall()
                for (value,) in rows:
                    meta=json.loads(value);name=meta['raw_path'];path=pathlib.PurePosixPath(name)
                    if path.is_absolute() or '..' in path.parts or not name.startswith('raw/'):raise StorageError('Unsafe raw evidence path')
                    archived=files[name];live=(root/name).read_bytes()
                    if hashlib.sha256(archived).hexdigest()!=meta['raw_hash'] or live!=archived:raise StorageError('Raw evidence checksum differs')
    stage('recovery_live_fingerprint')
    if snapshot_fingerprint(root)!=head['ledger_fingerprint']:raise StorageError('Current ledger differs; recovery refused')
    stage('recovery_stable_head_get')
    if remote.head()!=head or (root/'remote-head.json').read_bytes()!=prior_bytes:raise StorageError('Checkpoint changed during validation')
    # Preserve prior pointer, never replace ledger or delete raw/backup evidence.
    prior_hash=hashlib.sha256(prior_bytes).hexdigest()
    audit=root/f'remote-head-before-reconcile-{prior_hash}.json'
    if prior!=head:
        stage('recovery_prior_pointer_preserve')
        if audit.exists():
            if audit.read_bytes()!=prior_bytes:raise StorageError('Forensic pointer collision')
        else:
            with audit.open('xb') as f:f.write(prior_bytes);f.flush();os.fsync(f.fileno())
        persist_local_head(root,json.dumps(head,sort_keys=True).encode())
    stage('recovery_post_verify')
    if remote.head()!=head or json.loads((root/'remote-head.json').read_text())!=head or snapshot_fingerprint(root)!=head['ledger_fingerprint']:raise StorageError('Recovery postcondition differs')
    return {'status':'checkpoint_reconciled','checkpoint_sequence':head['sequence'],'already_current':prior==head,'paid_calls':0,'storage_writes':0,'ledger_writes':0,'raw_evidence_writes':0,'local_checkpoint_matches':True,'automatic_resume':False}

def from_env(study_id):
    return BunnyBackup(os.environ.get('RESEARCH_STORAGE_HOST',''),os.environ.get('RESEARCH_STORAGE_ZONE',''),os.environ.get('RESEARCH_STORAGE_ACCESS_KEY',''),study_id)
