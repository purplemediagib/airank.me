"""Private backup namespace with immutable snapshots and readback verification."""
import io,json,os,pathlib,re,sqlite3,tarfile,tempfile
from urllib.request import Request,build_opener,HTTPRedirectHandler
from urllib.error import HTTPError
from core import STUDY,canonical,digest,atomic,protocol_hash
def state_fingerprint(root):
    root=pathlib.Path(root)
    with sqlite3.connect('file:'+str(root/'ledger.sqlite')+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        state={table:[dict(r) for r in db.execute('SELECT * FROM '+table+' ORDER BY '+key)] for table,key in [('config','k'),('attempts','id'),('rounds','id')]}
    state['files']={str(p.relative_to(root)):digest(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file() and (p.parent.name in ('raw','manifests') or p.name in ('manifest.json','identity.json','prompts.json','schedule.json'))}
    return digest(canonical(state))

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('Storage redirect forbidden')
class Remote:
    def __init__(self,host,zone,key,study_id,transport=None):
        if study_id!=STUDY or not re.fullmatch(r'[A-Za-z0-9_-]+',zone or '') or not re.fullmatch(r'(?:[a-z]{2}\.)?storage\.bunnycdn\.com',host or '') or not key:raise ValueError('Invalid private storage setup')
        self.base=f'https://{host}/{zone}/{study_id}/';self.key=key;self.transport=transport or self.http
    def http(self,method,name,data=None):
        if name and not re.fullmatch(r'[a-zA-Z0-9_.-]+',name):raise ValueError('Unsafe backup key')
        req=Request(self.base+name,data,{'AccessKey':self.key,'Content-Type':'application/octet-stream'},method=method)
        try:
            with build_opener(NoRedirect).open(req,timeout=45) as r:return r.status,r.read()
        except HTTPError as e:
            if e.code==404:return 404,b''
            raise RuntimeError('Private storage HTTP '+str(e.code)) from None
    def get(self,name):
        status,data=self.transport('GET',name,None)
        if status==404:return None
        if status!=200:raise RuntimeError('Storage GET failed')
        return data
    def put_verified(self,name,data,immutable=True):
        old=self.get(name)
        if immutable and old is not None:
            if old!=data:raise RuntimeError('Immutable remote object differs')
            return
        # Reserve cumulative uploaded bytes before writing; orphan snapshots still count.
        # One writer externally enforced. Budget object is never auto-created during resumed work.
        budget_raw=self.get('storage-budget.json')
        if budget_raw is None:raise RuntimeError('Private storage budget missing')
        budget=json.loads(budget_raw)
        if budget.get('study_id')!=STUDY or budget.get('limit_bytes')!=1000000000:raise RuntimeError('Storage budget identity differs')
        new_budget=dict(budget,committed_bytes=budget['committed_bytes']+len(data)+4096)
        if new_budget['committed_bytes']>budget['limit_bytes']:raise RuntimeError('Storage 1GB cumulative upload bound reached')
        encoded=canonical(new_budget)
        status,_=self.transport('PUT','storage-budget.json',encoded)
        if status not in (200,201,204) or self.get('storage-budget.json')!=encoded:raise RuntimeError('Storage reservation unverified')
        status,_=self.transport('PUT',name,data)
        if status not in (200,201,204):raise RuntimeError('Storage PUT failed')
        if self.get(name)!=data:raise RuntimeError('Storage readback failed')
    def head(self):
        b=self.get('latest-backup.json');return json.loads(b) if b is not None else None
    def verify(self,root,m,check_state=True):
        marker=self.get('study-marker.json')
        expected={'study_id':STUDY,'provider_cap_micro_usd':m['provider_cap_micro_usd'],'protocol_sha256':protocol_hash(m)}
        if marker is None or json.loads(marker)!=expected:raise RuntimeError('Study marker differs/missing')
        path=pathlib.Path(root)/'remote-head.json'
        if not path.exists() or self.head()!=json.loads(path.read_text()):raise RuntimeError('Backup head differs; review recovery, never reset')
        head=self.head()
        data=self.get(head['archive'])
        if data is None or digest(data)!=head['sha256']:raise RuntimeError('Latest backup missing/corrupt')
        if check_state and head.get('state_sha256')!=state_fingerprint(root):raise RuntimeError('Local evidence differs from backed-up head; review required')
    def initialize_marker(self,m):
        expected=canonical({'study_id':STUDY,'provider_cap_micro_usd':m['provider_cap_micro_usd'],'protocol_sha256':protocol_hash(m)})
        if self.get('study-marker.json') is not None or self.head() is not None:raise RuntimeError('Remote study already exists; restore, do not initialize')
        if self.get('storage-budget.json') is not None:raise RuntimeError('Storage budget already exists; do not reset')
        budget=canonical({'study_id':STUDY,'limit_bytes':1000000000,'committed_bytes':4096})
        status,_=self.transport('PUT','storage-budget.json',budget)
        if status not in (200,201,204) or self.get('storage-budget.json')!=budget:raise RuntimeError('Initial storage budget unverified')
        self.put_verified('study-marker.json',expected)

def backup(root,ledger,remote,m,initial=False):
    root=pathlib.Path(root)
    if not initial:remote.verify(root,m,check_state=False)
    with tempfile.TemporaryDirectory(prefix='study-backup-') as td:
        dbpath=pathlib.Path(td)/'ledger.sqlite'
        with sqlite3.connect(dbpath) as target:ledger.db.backup(target)
        with sqlite3.connect(dbpath) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Ledger snapshot integrity failed')
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w:gz') as tar:
            tar.add(dbpath,arcname='ledger.sqlite')
            for name in ('identity.json','manifest.json','prompts.json','schedule.json'):
                if (root/name).exists():tar.add(root/name,arcname=name)
            for directory in ('raw','manifests'):
                if (root/directory).exists():tar.add(root/directory,arcname=directory)
        data=buf.getvalue();sha=digest(data);name='snapshot-'+sha+'.tar.gz'
        head=remote.head();sequence=1 if head is None else head['sequence']+1
        remote.put_verified(name,data)
        if head is not None:remote.put_verified('head-'+digest(canonical(head))+'.json',canonical(head))
        new={'study_id':STUDY,'archive':name,'sha256':sha,'sequence':sequence,'protocol_sha256':protocol_hash(m),'state_sha256':state_fingerprint(root)}
        if head is not None:new['previous_head_sha256']=digest(canonical(head))
        remote.put_verified('head-'+digest(canonical(new))+'.json',canonical(new))
        remote.put_verified('latest-backup.json',canonical(new),immutable=False)
        atomic(root/'remote-head.json',canonical(new))
        return new

def from_env():return Remote(os.environ.get('RESEARCH_STORAGE_HOST'),os.environ.get('RESEARCH_STORAGE_ZONE'),os.environ.get('RESEARCH_STORAGE_ACCESS_KEY'),STUDY)
