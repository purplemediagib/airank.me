"""Isolated study primitives. No imports read credentials or contact a network."""
import contextlib, datetime, fcntl, hashlib, json, os, pathlib, re, sqlite3, tempfile, time
STUDY='model-agreement-v01'
ENDPOINTS={'openai_api','kimi_api','claude_api'}
MICRO=1000000

def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(b):return hashlib.sha256(b).hexdigest()
def manifest_hash(m):return digest(canonical({k:v for k,v in m.items() if k!='manifest_sha256'}))
def protocol_hash(m):
    # Only an explicit activation may change these operational fields; model/prices/caps stay frozen.
    x=json.loads(canonical(m));
    for k in ('manifest_sha256','schedule_enabled','qualification_enabled','rounds','qualification_review_approved','status'):x.pop(k,None)
    for c in x.get('endpoints',{}).values():c.pop('qualified',None)
    return digest(canonical(x))
def utc_epoch(value):
    d=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if d.tzinfo is None:raise ValueError('Timezone required')
    return d.timestamp()
def sanitize(x):
    if isinstance(x,dict):return {k:sanitize(v) for k,v in x.items() if not re.search(r'authorization|cookie|secret|password|api.?key|credential|headers',k,re.I)}
    if isinstance(x,list):return [sanitize(v) for v in x]
    if isinstance(x,str):
        x=re.sub(r'\b(?:Bearer|Basic)\s+\S+|\bsk-[A-Za-z0-9_-]+','[REDACTED]',x,flags=re.I)
        return re.sub(r'([?&](?:key|token|api_key|signature|access_token)=)[^&#\s]+',r'\1[REDACTED]',x)
    return x

def atomic(path,data):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.write-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
        fd=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def write_once(path,data):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if path.read_bytes()!=data:raise RuntimeError('Immutable evidence differs')
        return digest(data)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    return digest(data)

@contextlib.contextmanager
def locked(root):
    root=pathlib.Path(root)
    if not root.exists():raise RuntimeError('Study must be explicitly initialized')
    with (root/'runner.lock').open('a+b') as f:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield


def validate(m,prompts,slots,live=False,now=None,qualification=False):
    now=time.time() if now is None else now
    if m.get('study_id')!=STUDY or m.get('manifest_sha256')!=manifest_hash(m):raise ValueError('Study identity or manifest hash invalid')
    if m.get('market')!='FI' or m.get('language')!='en':raise ValueError('Unapproved market/language')
    if set(m.get('endpoints',{}))!=ENDPOINTS:raise ValueError('Exactly three endpoints required')
    if m.get('prompt_hash')!=digest(canonical(prompts)) or m.get('schedule_hash')!=digest(canonical(slots)):raise ValueError('Frozen inputs differ')
    ids={p['prompt_id'] for p in prompts}
    if len(prompts)!=20 or len(ids)!=20 or any(not isinstance(p.get('text'),str) or not p['text'].strip() for p in prompts):raise ValueError('Invalid prompt panel')
    if len(slots)!=180 or len({s['slot_id'] for s in slots})!=180:raise ValueError('Invalid slot matrix')
    groups={}
    for s in slots:
        if s['endpoint'] not in ENDPOINTS or s['prompt_id'] not in ids or s['round'] not in (1,2,3):raise ValueError('Invalid slot')
        if s['slot_id']!=f"{STUDY}:r{s['round']}:{s['prompt_id']}:{s['endpoint']}":raise ValueError('Slot identity mismatch')
        if s.get('comparison_group')!=f"r{s['round']}:{s['prompt_id']}":raise ValueError('Comparison group mismatch')
        groups.setdefault(s['comparison_group'],[]).append(s)
    if len(groups)!=60 or any(len(g)!=3 or {s['endpoint'] for s in g}!=ENDPOINTS or {s['order_within_group'] for s in g}!={1,2,3} for g in groups.values()):raise ValueError('Invalid comparison matrix')
    if [s['round'] for s in slots]!=sorted(s['round'] for s in slots):raise ValueError('Rounds out of execution order')
    for i in range(0,len(slots),3):
        group=slots[i:i+3]
        if len({x['comparison_group'] for x in group})!=1 or [x['order_within_group'] for x in group]!=[1,2,3]:raise ValueError('Comparison adjacency/order differs from labels')
    # All rounds place each endpoint in each ordinal position for each prompt.
    for p in ids:
        for ep in ENDPOINTS:
            if {s['order_within_group'] for s in slots if s['prompt_id']==p and s['endpoint']==ep}!={1,2,3}:raise ValueError('Endpoint order is not counterbalanced')
    if not live:return
    for name in ('spend_approved','protocol_frozen','storage_verified','singleton_verified','hosting_bound_verified','paid_enabled'):
        if m.get(name) is not True:raise RuntimeError('Closed gate: '+name)
    if m.get('approved_total_micro_usd')!=40*MICRO:raise RuntimeError('Wrong owner ceiling')
    caps=[m.get(k) for k in ('provider_cap_micro_usd','hosting_bound_micro_usd','contingency_micro_usd')]
    if any(type(v)!=int or v<0 for v in caps) or not caps[0] or sum(caps)>40*MICRO:raise RuntimeError('Total allocation exceeds approved ceiling')
    if not m.get('hosting_bound_evidence') or not m.get('hosting_stop_evidence'):raise RuntimeError('Hosting cost/stop evidence absent')
    if now>=utc_epoch(m['execution_expires_at_utc']):raise RuntimeError('Execution authority expired')
    if type(m.get('diagnostic_limit'))!=int or not 1<=m['diagnostic_limit']<=18:raise RuntimeError('Invalid diagnostic allowance')
    if type(m.get('retry_limit'))!=int or not 0<=m['retry_limit']<=18:raise RuntimeError('Invalid retry allowance')
    if qualification:
        if m.get('qualification_enabled') is not True:raise RuntimeError('Qualification disabled')
    else:
        if m.get('schedule_enabled') is not True:raise RuntimeError('Schedule disabled')
        windows=m.get('rounds',[])
        if len(windows)!=3 or {r.get('round') for r in windows}!={1,2,3}:raise RuntimeError('Three frozen windows required')
        for r in windows:
            start,end=utc_epoch(r['start_utc']),utc_epoch(r['end_utc'])
            if not start<end<=utc_epoch(m['execution_expires_at_utc']) or end-start>7200:raise RuntimeError('Invalid round timing')
            if not 0<=r.get('start_grace_seconds',-1)<=600:raise RuntimeError('Invalid start grace')
        ordered=sorted(windows,key=lambda x:x['round'])
        if any(utc_epoch(a['end_utc'])>=utc_epoch(b['start_utc']) for a,b in zip(ordered,ordered[1:])):raise RuntimeError('Overlapping rounds')
    for ep,c in m['endpoints'].items():
        if not c.get('model') or not c.get('allowed_models') or c.get('bound_verified') is not True or not c.get('bound_evidence'):raise RuntimeError('Unverified route/bound '+ep)
        if type(c.get('reservation_micro_usd'))!=int or not 0<c['reservation_micro_usd']<=caps[0]:raise RuntimeError('Invalid reservation')
        if not qualification and c.get('qualified') is not True:raise RuntimeError('Unqualified endpoint '+ep)
        if type(c.get('timeout_seconds'))!=int or not 1<=c['timeout_seconds']<=300:raise RuntimeError('Unbounded timeout')
        if not c.get('request_parameters') or not c.get('price'):raise RuntimeError('Request/pricing config absent')
        if ep=='kimi_api' and (not c.get('provider') or not c.get('allowed_providers')):raise RuntimeError('Unpinned Kimi provider')

class Ledger:
    def __init__(self,root,m,initialize=False):
        self.root=pathlib.Path(root);path=self.root/'ledger.sqlite'
        if not initialize and not path.exists():raise RuntimeError('Missing ledger; never reset')
        self.db=sqlite3.connect(path,isolation_level=None);self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY,v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,slot TEXT NOT NULL,endpoint TEXT NOT NULL,kind TEXT NOT NULL,n INTEGER NOT NULL,status TEXT NOT NULL,reserved INTEGER NOT NULL,accounted INTEGER,cost_basis TEXT,start REAL NOT NULL,end REAL,error TEXT,raw_path TEXT,raw_hash TEXT,retry_at REAL,UNIQUE(slot,n));
CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY,state TEXT NOT NULL,start REAL,end REAL,reason TEXT);''')
        expected={'study_id':m['study_id'],'provider_cap':str(m['provider_cap_micro_usd']),'protocol_sha256':protocol_hash(m)}
        for k,v in expected.items():
            old=self.db.execute('SELECT v FROM config WHERE k=?',(k,)).fetchone()
            if old and old['v']!=v:raise RuntimeError('Ledger identity/configuration differs')
            if not old:
                if not initialize:raise RuntimeError('Incomplete ledger; restore')
                self.db.execute('INSERT INTO config VALUES (?,?)',(k,v))
    def close(self):self.db.close()
    def halt(self,reason):self.db.execute("INSERT OR REPLACE INTO config VALUES ('halt',?)",(reason,))
    def rows(self):return [dict(r) for r in self.db.execute('SELECT * FROM attempts ORDER BY start,id')]
    def summary(self):
        rows=self.rows()
        return {'attempts':len(rows),'committed_or_held_micro_usd':sum(r['accounted'] if r['accounted'] is not None else r['reserved'] for r in rows),'unresolved':sum(r['accounted'] is None for r in rows),'halted':bool(self.db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone())}
    def claim(self,slot,ep,kind,bound,m,now):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.summary()['halted'] or self.summary()['unresolved']:raise RuntimeError('Unresolved request or halted ledger')
            prev=self.db.execute('SELECT * FROM attempts WHERE slot=? ORDER BY n',(slot,)).fetchall();n=len(prev)+1
            if prev:
                if kind!='primary' or n!=2 or prev[-1]['status']!='retryable' or now<prev[-1]['retry_at']:raise RuntimeError('No replay/retry permitted')
                if self.db.execute('SELECT COUNT(*) FROM attempts WHERE n=2').fetchone()[0]>=m['retry_limit']:raise RuntimeError('Retry pool exhausted')
            elif kind=='diagnostic':
                if self.db.execute("SELECT COUNT(*) FROM attempts WHERE kind='diagnostic'").fetchone()[0]>=m['diagnostic_limit']:raise RuntimeError('Diagnostic pool exhausted')
            elif kind!='primary':raise ValueError('Invalid attempt kind')
            if self.summary()['committed_or_held_micro_usd']+bound>m['provider_cap_micro_usd']:raise RuntimeError('Provider cap would be exceeded')
            aid=f'{slot}:a{n}'
            self.db.execute('INSERT INTO attempts(id,slot,endpoint,kind,n,status,reserved,start) VALUES (?,?,?,?,?,?,?,?)',(aid,slot,ep,kind,n,'reserved',bound,now));self.db.execute('COMMIT');return aid
        except Exception:self.db.execute('ROLLBACK');raise
    def finish(self,aid,status,raw_path,raw_hash,accounted,basis,end,error=None,retry_after=60):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            r=self.db.execute('SELECT * FROM attempts WHERE id=?',(aid,)).fetchone()
            if not r or r['status']!='reserved':raise RuntimeError('Attempt already finalized')
            if accounted is not None and (type(accounted)!=int or accounted<0):raise ValueError('Invalid cost')
            if status not in ('complete','incomplete','retryable','fatal','unknown'):raise ValueError('Invalid outcome')
            if status=='retryable' and error not in ('timeout','429','5xx'):raise ValueError('Content retry forbidden')
            self.db.execute('UPDATE attempts SET status=?,accounted=?,cost_basis=?,end=?,error=?,raw_path=?,raw_hash=?,retry_at=? WHERE id=?',(status,accounted,basis,end,error,raw_path,raw_hash,end+max(60,retry_after),aid))
            if status in ('fatal','unknown') or accounted is None or accounted>r['reserved']:self.halt('uncertain_or_excess_charge_or_fatal')
            self.db.execute('COMMIT')
        except Exception:self.db.execute('ROLLBACK');raise
