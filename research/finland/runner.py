"""Offline-only research scaffold. No network adapter or credential access exists."""
import argparse, collections, csv, hashlib, json, pathlib, random, re, sqlite3, time
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
ROOT = pathlib.Path(__file__).parent
MODEL = 'gpt-4.1-mini-2025-04-14'
SYSTEM = "Respond to the user's purchasing question. Do not invent businesses, sources or capabilities. Use the configured search tool when available. Follow the requested answer language."

def digest(data):
    return hashlib.sha256(data).hexdigest()

def load_inputs(root=ROOT/'inputs', endpoint='openai_responses'):
    prompts = json.loads((root/'prompt_pairs.json').read_text())
    schedule = 'schedule_v02_openai_kimi_DRAFT.json' if (root/'schedule_v02_openai_kimi_DRAFT.json').exists() else 'proposed_schedule.json'
    slots = [s for s in json.loads((root/schedule).read_text()) if s['endpoint']==endpoint]
    assert len(prompts)==12 and len({p['intent_id'] for p in prompts})==12
    assert len(slots)==144 and len({s['slot_id'] for s in slots})==144
    ids={p['intent_id'] for p in prompts}
    assert all(s['intent_id'] in ids and s['language'] in ('fi','en') for s in slots)
    pairs=collections.Counter((s['proposed_date_utc'],s['proposed_block_utc'],s['intent_id']) for s in slots)
    assert len(pairs)==72 and set(pairs.values())=={2}
    for i in range(0,144,2):
        a,b=slots[i:i+2]
        assert (a['intent_id'],a['proposed_date_utc'],a['proposed_block_utc'])==(b['intent_id'],b['proposed_date_utc'],b['proposed_block_utc'])
        assert {a['language'],b['language']}=={'fi','en'}
    return prompts,slots

def hashes(root=ROOT/'inputs'):
    return {p.name:digest(p.read_bytes()) for p in sorted(root.iterdir()) if p.is_file()}

def validate_live(manifest):
    required=('owner_spend_approval','diagnostic_approval','finnish_review','model_qualification','verified_billable_caps','protocol_freeze','execution_route_approval')
    missing=[k for k in required if not manifest.get(k)]
    if missing: raise RuntimeError('BLOCKED: '+', '.join(missing))
    if manifest.get('input_hashes')!=hashes(): raise RuntimeError('Frozen input mismatch')
    if manifest.get('model')!=MODEL: raise RuntimeError('Model change requires owner-informed amended freeze')
    raise RuntimeError('BLOCKED: live adapter deliberately not implemented; approval alone cannot execute')

def sanitize(x):
    if isinstance(x,dict):
        return {k:sanitize(v) for k,v in x.items() if not re.search(r'authorization|cookie|secret|password|api.?key|credential|headers',k,re.I)}
    if isinstance(x,list): return [sanitize(v) for v in x]
    if isinstance(x,str):
        x=re.sub(r'\b(?:Bearer|Basic)\s+\S+|\bsk-[A-Za-z0-9_-]+','[REDACTED]',x,flags=re.I)
        x=re.sub(r'([?&](?:key|token|api_key|signature|access_token)=)[^&#\s]+',r'\1[REDACTED]',x,flags=re.I)
        return re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@',r'\1[REDACTED]@',x)
    return x

def normalized_url(url):
    p=urlsplit(url)
    if p.scheme not in ('http','https') or p.username or p.password: raise ValueError('Unsafe URL')
    q=[(k,v) for k,v in parse_qsl(p.query,keep_blank_values=True) if not k.lower().startswith('utm_') and k.lower() not in ('gclid','fbclid')]
    return urlunsplit((p.scheme,p.netloc.lower(),p.path,urlencode(q),''))

class Ledger:
    """Integer micro-USD reservations, SQLite atomic claims, fail-closed unknown costs."""
    def __init__(self,path,ceiling=38_000_000,primary_limit=288):
        self.db=sqlite3.connect(path,isolation_level=None)
        self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY,v TEXT);
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,slot TEXT,kind TEXT,n INTEGER,parent TEXT,status TEXT,reserved INTEGER,actual INTEGER,start REAL,end REAL,error TEXT,raw TEXT,UNIQUE(slot,n));''')
        self.db.execute('INSERT OR IGNORE INTO config VALUES (?,?)',('ceiling',str(ceiling)))
        self.db.execute('INSERT OR IGNORE INTO config VALUES (?,?)',('primary_limit',str(primary_limit)))
        if int(self.db.execute("SELECT v FROM config WHERE k='primary_limit'").fetchone()[0])!=primary_limit: raise ValueError('Cannot change primary limit')
        if int(self.db.execute("SELECT v FROM config WHERE k='ceiling'").fetchone()[0])!=ceiling: raise ValueError('Cannot change ledger ceiling')
    def reserve(self,slot,kind='primary',bound=29200,now=None):
        if kind not in ('primary','diagnostic') or type(bound)!=int or bound<=0: raise ValueError('Invalid reservation')
        now=time.time() if now is None else now
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone(): raise RuntimeError('Ledger halted')
            prior=self.db.execute('SELECT * FROM attempts WHERE slot=? ORDER BY n',(slot,)).fetchall()
            n=len(prior)+1
            if prior:
                p=prior[-1]
                if kind!='primary' or p['kind']!=kind or n>2 or p['status']!='retryable' or now<float((self.db.execute('SELECT v FROM config WHERE k=?',('retry_at:'+p['id'],)).fetchone() or [p['end']+60])[0]): raise RuntimeError('Retry ineligible or too early')
            if kind=='diagnostic' and self.db.execute("SELECT COUNT(*) FROM attempts WHERE kind='diagnostic'").fetchone()[0]>=20: raise RuntimeError('Diagnostic allowance exhausted')
            if kind=='primary' and not prior and self.db.execute("SELECT COUNT(DISTINCT slot) FROM attempts WHERE kind='primary'").fetchone()[0]>=int(self.db.execute("SELECT v FROM config WHERE k='primary_limit'").fetchone()[0]): raise RuntimeError('Primary allowance exhausted')
            used=self.db.execute('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM attempts').fetchone()[0]
            cap=int(self.db.execute("SELECT v FROM config WHERE k='ceiling'").fetchone()[0])
            if used+bound>cap: raise RuntimeError('Budget reservation refused')
            aid=f'{slot}:a{n}'
            self.db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',(aid,slot,kind,n,prior[-1]['id'] if prior else None,'reserved',bound,None,now,None,None,None))
            self.db.execute('COMMIT'); return aid
        except Exception:
            self.db.execute('ROLLBACK'); raise
    def finish(self,aid,status,raw,actual=None,error=None,end=None,retry_after=60):
        if status not in ('complete','incomplete','retryable','fatal','unknown'): raise ValueError('Invalid status')
        if actual is not None and (type(actual)!=int or actual<0): raise ValueError('Invalid actual cost')
        if status=='retryable' and error not in ('timeout','429','5xx'): raise ValueError('Only transport failures retry')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row=self.db.execute('SELECT * FROM attempts WHERE id=?',(aid,)).fetchone()
            if not row or row['status']!='reserved': raise RuntimeError('Attempt already finalized or missing')
            end=time.time() if end is None else end
            # Store eligibility timestamp as end plus provider wait beyond baseline 60 seconds.
            if status=='retryable':self.db.execute('INSERT OR REPLACE INTO config VALUES (?,?)',('retry_at:'+aid,str(end+max(60,retry_after))))
            eligible_end=end
            self.db.execute('UPDATE attempts SET status=?,actual=?,end=?,error=?,raw=? WHERE id=?',(status,actual,eligible_end,error,json.dumps(sanitize(raw),ensure_ascii=False),aid))
            if status in ('fatal','unknown') or (actual is not None and actual>row['reserved']):
                self.db.execute("INSERT OR REPLACE INTO config VALUES ('halt','cost/transport/configuration uncertainty')")
            self.db.execute('COMMIT')
        except Exception:
            self.db.execute('ROLLBACK'); raise
    def rows(self): return [dict(x) for x in self.db.execute('SELECT * FROM attempts ORDER BY start,id')]

class StudyLedger(Ledger):
    """One shared $38 ledger. Unverified bounds cannot authorize a reservation."""
    def __init__(self,path,verified_bounds=None,initialize=False):
        if not pathlib.Path(path).exists() and not initialize:raise RuntimeError('Missing initialized study ledger; restore verified backup, never reset budget')
        super().__init__(path,ceiling=38_000_000,primary_limit=288)
        self.verified_bounds=verified_bounds or {}
        self.allowed={s['slot_id']:s['endpoint'] for endpoint in ('openai_responses','kimi_candidate') for s in load_inputs(endpoint=endpoint)[1]}
    def reserve_study(self,slot,endpoint,kind='primary',now=None):
        if endpoint not in ('openai_responses','kimi_candidate'):raise ValueError('Unapproved endpoint')
        spec=self.verified_bounds.get(endpoint)
        if not spec or not spec.get('evidence') or spec.get('verified') is not True:
            raise RuntimeError('No verified all-billable request bound; execution blocked')
        bound=spec.get('micro_usd')
        if type(bound)!=int or bound<=0:raise RuntimeError('Invalid all-billable bound')
        if kind=='primary' and self.allowed.get(slot)!=endpoint:raise ValueError('Slot not in study schedule')
        if kind=='diagnostic' and not slot.startswith('diagnostic:'+endpoint+':'):raise ValueError('Diagnostic namespace required')
        return super().reserve(slot,kind,bound,now)
    def reserve(self,*args,**kwargs):
        raise RuntimeError('Use reserve_study with verified endpoint bound')
    def summary(self):
        rows=self.rows()
        return {'approved_total_usd':38,'committed_or_held_micro_usd':sum(x['actual'] if x['actual'] is not None else x['reserved'] for x in rows),'uncertain_charge_hold_micro_usd':sum(x['reserved'] for x in rows if x['actual'] is None),'attempts':len(rows),'diagnostic_attempts':sum(x['kind']=='diagnostic' for x in rows),'primary_slots':len({x['slot'] for x in rows if x['kind']=='primary'})}

def parse_response(raw):
    output=raw.get('output',[])
    blocks=[b for o in output if o.get('type')=='message' for b in o.get('content',[])]
    calls=[o for o in output if o.get('type')=='web_search_call']
    citations=[{'raw_url':a['url'],'normalized_url':normalized_url(a['url']),'source_origin':'annotation','explicitly_cited':True,'page_language':'unknown','registrable_domain':None} for b in blocks for a in b.get('annotations',[]) if a.get('type')=='url_citation']
    # Missing telemetry is not proof of no grounding; registrable domains require reviewed PSL handling.
    return {'answer':'\n'.join(b.get('text',b.get('refusal','')) for b in blocks), 'returned_model':raw.get('model'), 'usable':raw.get('status')=='completed' and not raw.get('incomplete_details') and not raw.get('error') and all(o.get('status') in (None,'completed') for o in output if o.get('type') in ('message','web_search_call')), 'refusal':any(b.get('type')=='refusal' for b in blocks),'tool_calls':len(calls),'grounding_status':'verified' if any(c.get('status')=='completed' for c in calls) else 'unknown','usage':raw.get('usage'), 'citations':citations}

def overlap(a,b):
    if a is None or b is None:return None
    a,b=set(a),set(b)
    return len(a&b)/len(a|b) if a|b else None

def analyze(pairs):
    by=collections.defaultdict(list); counts=collections.Counter()
    for p in pairs:
        if not p.get('usable',True): counts['unusable']+=1;continue
        if p.get('span_seconds',0)>600: counts['late']+=1;continue
        if p['fi'] is None or p['en'] is None:counts['missing']+=1;continue
        j=overlap(p['fi'],p['en'])
        if j is None:counts['both_empty']+=1;continue
        by[p['intent_id']].append(j);counts['eligible']+=1
    means={i:sum(v)/len(v) for i,v in sorted(by.items())}
    return {'macro_jaccard':sum(means.values())/len(means) if means else None,'contributing_intents':len(means),'expected_intents':12,'intent_means':means,'eligible_pairs_per_intent':{i:len(v) for i,v in by.items()},'coverage':dict(counts)}

def review_sample(prompts,slots):
    sectors={p['intent_id']:p['sector'] for p in prompts}; strata=collections.defaultdict(list)
    for s in slots:strata[(sectors[s['intent_id']],s['language'],s['proposed_date_utc'])].append(s['slot_id'])
    rng=random.Random(20261030)
    return sorted(x for k in sorted(strata) for x in rng.sample(sorted(strata[k]),2))

def dry_run(out, endpoint='openai_responses'):
    prompts,slots=load_inputs(endpoint=endpoint); out=pathlib.Path(out)
    if out.exists():raise RuntimeError('Use a new output folder; never overwrite evidence')
    out.mkdir(parents=True);(out/'SYNTHETIC_ONLY_NOT_RESEARCH_DATA').touch()
    (out/'raw').mkdir(); ledger=Ledger(out/'synthetic.sqlite'); pmap={p['intent_id']:p for p in prompts}; runs=[]; citations=[]
    for i,s in enumerate(slots):
        aid=ledger.reserve(s['slot_id'],now=i*2)
        raw={'synthetic':True,'id':'fixture-'+str(i),'model':MODEL if endpoint=='openai_responses' else 'KIMI_UNQUALIFIED_SYNTHETIC','status':'completed','output':[{'type':'web_search_call','status':'completed'},{'type':'message','content':[{'type':'output_text','text':'Synthetic fixture: Example Provider. Not a research observation.','annotations':[{'type':'url_citation','url':'https://example.invalid/source?utm_source=test'}]}]}],'usage':{'input_tokens':400,'output_tokens':30}}
        ledger.finish(aid,'complete',raw,actual=10000,end=i*2+1)
        rb=json.dumps(raw,ensure_ascii=False).encode(); name=f'raw/{i:03d}.json';(out/name).write_bytes(rb)
        parsed=parse_response(raw); prompt=pmap[s['intent_id']][s['language']]
        runs.append({**s,**parsed,'synthetic':True,'attempt_id':aid,'prompt_text':prompt,'prompt_hash':digest(prompt.encode()),'system_text':SYSTEM,'system_hash':digest(SYSTEM.encode()),'requested_model':MODEL if endpoint=='openai_responses' else None,'raw_path':name,'raw_hash':digest(rb),'actual_start_seconds_fixture':i*2,'end_seconds_fixture':i*2+1,'billing_reconciliation_status':'SYNTHETIC_NOT_BILLED'})
        citations.extend({'slot_id':s['slot_id'],**c} for c in parsed['citations'])
    for name,rows in [('runs.jsonl',runs),('citations.jsonl',citations)]:
        (out/name).write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
    with (out/'entities_for_human_review.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['slot_id','canonical_entity_id','raw_name','official_domain','mention_present','recommended_yes_no_unclear','recommendation_position','Finland_service_eligibility','supporting_text_span','identity_source_url','coder','reviewer','adjudication'])
        for s in slots:w.writerow([s['slot_id']]+['']*12)
    (out/'independent_review_sample.json').write_text(json.dumps(review_sample(prompts,slots),indent=2))
    (out/'input_hashes.json').write_text(json.dumps(hashes(),indent=2))
    return {'synthetic_attempts':len(ledger.rows()),'review_sample':36,'output':str(out),'paid_calls':0}

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--dry-run',type=pathlib.Path,required=True); ap.add_argument('--endpoint',choices=['openai_responses','kimi_candidate'],default='openai_responses')
    args=ap.parse_args(); print(json.dumps(dry_run(args.dry_run,args.endpoint),indent=2))
