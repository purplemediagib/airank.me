"""Research host bootstrap. Default idle; paid dispatch requires explicit CLI and gates."""
import argparse, contextlib, datetime, fcntl, hashlib, http.server, json, os, pathlib, sqlite3, tempfile, time, tarfile
import adapters
import runner

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def write_once(path,data):
    data=json.dumps(data,ensure_ascii=False,sort_keys=True).encode()
    with open(path,'xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    return hashlib.sha256(data).hexdigest()

@contextlib.contextmanager
def singleflight(root):
    root=pathlib.Path(root)
    if not root.is_dir():raise RuntimeError('Data directory missing; explicit init required')
    with (root/'runner.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another research process owns the ledger') from None
        yield

def initialize(root,study_id):
    root=pathlib.Path(root)
    if not study_id or not all(c.isalnum() or c in '-_.' for c in study_id):raise ValueError('Invalid study identity')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with singleflight(root):
        if (root/'identity.json').exists() or (root/'ledger.sqlite').exists():raise RuntimeError('Already initialized; never reset study balance')
        for name in ('raw','backups','manifests'): (root/name).mkdir(mode=0o700)
        ledger=runner.StudyLedger(root/'ledger.sqlite',initialize=True)
        ledger.db.execute("INSERT INTO config VALUES ('study_id',?)",(study_id,));ledger.db.close()
        write_once(root/'identity.json',{'study_id':study_id,'initialized_at':utc(),'provider_cap_micro_usd':38_000_000})
    return {'initialized':True,'study_id':study_id,'paid_calls':0}

def open_study(root,study_id,bounds):
    root=pathlib.Path(root)
    try:identity=json.loads((root/'identity.json').read_text())
    except (FileNotFoundError,ValueError):raise RuntimeError('Study identity missing/corrupt; restore verified backup') from None
    if identity.get('study_id')!=study_id or identity.get('provider_cap_micro_usd')!=38_000_000:raise RuntimeError('Study identity mismatch')
    ledger=runner.StudyLedger(root/'ledger.sqlite',bounds)
    row=ledger.db.execute("SELECT v FROM config WHERE k='study_id'").fetchone()
    if not row or row[0]!=study_id:ledger.db.close();raise RuntimeError('Database identity mismatch')
    if ledger.db.execute('PRAGMA quick_check').fetchone()[0]!='ok':ledger.db.close();raise RuntimeError('Ledger integrity failure')
    return ledger

def backup(root,ledger,tag,hook=None):
    """Consistent local snapshot; optional injected private remote-backup hook.
    Hook returns a durable reference/hash; never invoke shell strings from a manifest.
    """
    root=pathlib.Path(root);dest=root/'backups'/f'{tag}.sqlite'
    if dest.exists():raise RuntimeError('Backup already exists')
    with sqlite3.connect(dest) as target:ledger.db.backup(target)
    archive=root/'backups'/f'{tag}.tar.gz'
    with tarfile.open(archive,'x:gz') as tar:
        tar.add(dest,arcname='ledger.sqlite');tar.add(root/'identity.json',arcname='identity.json');tar.add(root/'raw',arcname='raw');tar.add(root/'manifests',arcname='manifests');tar.add(runner.ROOT/'inputs',arcname='inputs')
    digest=runner.digest(archive.read_bytes()); result={'path':str(archive),'sha256':digest,'created_at':utc()}
    if hook:
        ack=hook(archive,digest)
        if not isinstance(ack,dict) or ack.get('verified') is not True or ack.get('sha256')!=digest or not ack.get('reference'):raise RuntimeError('Private backup not verified')
        result['remote']=ack
    write_once(root/'backups'/f'{tag}.json',result)
    if hook and getattr(hook,'delete_local_after_verified',False):
        # Only redundant local snapshots are removed, after verified private remote upload/head.
        # Primary raw evidence and durable ledger remain untouched.
        dest.unlink();archive.unlink()
    return result

def manifest_hash(m):
    return runner.digest(json.dumps({k:v for k,v in m.items() if k!='frozen_manifest_sha256'},sort_keys=True,separators=(',',':')).encode())

def execution_gate(m,kind):
    if runner.sanitize(m)!=m:raise RuntimeError('Manifest must not contain credentials')
    common=['owner_execution_approved','secure_host_verified','durable_storage_verified','private_backup_verified','all_billable_bounds_verified']
    if kind=='primary':common+=['finnish_review_signed','protocol_frozen','models_qualified']
    else:common+=['diagnostics_approved']
    missing=[k for k in common if m.get(k) is not True]
    if missing:raise RuntimeError('Execution gates closed: '+', '.join(missing))
    if m.get('provider_budget_usd')!=38 or m.get('hosting_budget_usd')!=2:raise RuntimeError('Budget allocation mismatch')
    if m.get('input_hashes')!=runner.hashes():raise RuntimeError('Inputs not frozen to this image')
    if not m.get('study_id'):raise RuntimeError('Study identity absent')
    if m.get('frozen_manifest_sha256')!=manifest_hash(m):raise RuntimeError('Provider settings/bounds manifest hash mismatch')

def execute_one(root,m,slot,kind='primary',transport=None,backup_hook=None,key_loader=None):
    """Only paid entry point; reservation precedes request, one request only, no auto retry."""
    execution_gate(m,kind)
    if backup_hook is None:raise RuntimeError('Verified private external backup hook required before paid dispatch')
    endpoint=slot['endpoint'];config=m['providers'][endpoint]
    if not config.get('all_billable_bound_verified'):raise RuntimeError('Endpoint billing bound absent')
    if kind=='primary' and (not config.get('qualified') or not config.get('allowed_returned_models')):raise RuntimeError('Model qualification/version policy absent')
    if kind=='diagnostic' and not config.get('diagnostic_route_approved'):raise RuntimeError('Diagnostic route not approved')
    prompts,scheduled=runner.load_inputs(endpoint=endpoint)
    if kind=='primary' and slot not in scheduled:raise RuntimeError('Slot differs from frozen schedule')
    pmap={p['intent_id']:p for p in prompts}
    prompt=pmap[slot['intent_id']][slot['language']]
    # Qualification assesses the model; only its separately authorized/bounded diagnostic route bypasses qualified flag.
    dispatch_config={**config,'qualified':True}
    with singleflight(root):
        if hasattr(backup_hook,'verify_head'):backup_hook.verify_head(root)
        ledger=open_study(root,m['study_id'],m['verified_bounds'])
        try:
            manifest_path=pathlib.Path(root)/'manifests'/f"{m['frozen_manifest_sha256']}.json"
            if not manifest_path.exists():write_once(manifest_path,m)
            # Unfinished reservation means a prior request may have been charged. Never continue blindly.
            if ledger.db.execute("SELECT 1 FROM attempts WHERE status='reserved' OR (actual IS NULL AND NOT EXISTS (SELECT 1 FROM accounting WHERE attempt_id=attempts.id))").fetchone():raise RuntimeError('Unresolved prior request; manual reconciliation required')
            aid=ledger.reserve_study(slot['slot_id'],endpoint,kind)
            tag=hashlib.sha256(aid.encode()).hexdigest()
            backup(root,ledger,tag+'-reserved',backup_hook)
            loader=key_loader or (lambda name:os.environ.get(name))
            key=loader('OPENAI_API_KEY' if endpoint=='openai_responses' else 'OPENROUTER_API_KEY')
            if not key:
                ledger.finish(aid,'fatal',{'error':'missing_credential'},actual=0,error='missing_credential')
                raise RuntimeError('Provider credential not configured')
            started=utc();request_start=time.time()
            ledger.db.execute('INSERT OR REPLACE INTO config VALUES (?,?)',('request_start:'+aid,str(request_start)))
            try:
                fn=adapters.request_openai if endpoint=='openai_responses' else adapters.request_kimi
                response=fn(prompt,dispatch_config,key,transport=transport or adapters.http_json)
                response_end=time.time()
            except adapters.ProviderError as e:
                retryable=e.category in ('timeout','429','5xx')
                ledger.finish(aid,'retryable' if retryable else 'fatal',{'error':e.category},actual=None,error=e.category,retry_after=e.retry_after)
                backup(root,ledger,tag+'-error',backup_hook)
                return {'attempt_id':aid,'status':'retryable' if retryable else 'fatal','cost_hold_retained':True}
            finally:key=None
            evidence={'study_id':m['study_id'],'slot':slot,'attempt_id':aid,'started_at':started,'ended_at':datetime.datetime.fromtimestamp(response_end,datetime.timezone.utc).isoformat(),'prompt_hash':runner.digest(prompt.encode()),'requested_model':config.get('model'),'response':runner.sanitize(response)}
            raw_hash=write_once(pathlib.Path(root)/'raw'/f'{tag}.json',evidence)
            # Provider costs must be verified all-in; absent/uncertain usage retains full hold and stops execution.
            import accounting
            charge=accounting.cost(response,endpoint,config)
            actual=charge['actual'];accounted=charge['accounted']
            complete=(runner.parse_response(response)['usable'] if endpoint=='openai_responses' else bool(response.get('choices')) and all(c.get('finish_reason') in ('stop',) for c in response['choices']))
            status=('complete' if complete else 'incomplete') if actual is not None or accounted is not None else 'unknown'
            if kind=='primary' and response.get('model') not in config['allowed_returned_models']:status='fatal'
            ledger.finish(aid,status,{'raw_path':f'raw/{tag}.json','raw_hash':raw_hash},actual=actual,end=response_end,accounted=accounted,accounting_basis=charge['basis'])
            backup(root,ledger,tag+'-finished',backup_hook)
            return {'attempt_id':aid,'status':status,'raw_hash':raw_hash,'cost_hold_retained':actual is None and accounted is None,'accounting_basis':charge['basis'],'provider_actual_cost_micro_usd':actual,'conservative_accounted_micro_usd':accounted}
        finally:ledger.db.close()

class Health(http.server.BaseHTTPRequestHandler):
    state='idle'
    def do_GET(self):
        if self.path!='/healthz':self.send_error(404);return
        body=json.dumps({'status':Health.state,'management_api':False}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass

def perform(args):
    if args.manifest:m=json.loads(pathlib.Path(args.manifest).read_text())
    elif os.environ.get('RESEARCH_MANIFEST_JSON'):m=json.loads(os.environ['RESEARCH_MANIFEST_JSON'])
    else:raise RuntimeError('Explicit reviewed manifest required')
    if m.get('storage_access_approved') is not True:raise RuntimeError('Private storage access not approved')
    if m.get('frozen_manifest_sha256')!=manifest_hash(m):raise RuntimeError('Manifest hash mismatch')
    import storage
    remote=storage.from_env(m['study_id'])
    if args.mode=='init':
        if args.study_id!=m['study_id']:raise RuntimeError('Study ID differs from manifest')
        root=pathlib.Path(args.data_dir);prior=remote.read_marker()
        if (root/'identity.json').exists():
            ledger=open_study(root,args.study_id,{})
            try:
                if ledger.rows():raise RuntimeError('Existing attempt history; initialization forbidden')
            finally:ledger.db.close()
        else:
            if prior is not None:raise RuntimeError('Remote study exists but local identity absent; restore backup')
            initialize(root,args.study_id)
        identity=json.loads((root/'identity.json').read_text())
        remote.ensure_marker(identity)
        if (root/'remote-head.json').exists():remote.verify_head(root)
        else:
            if remote.head() is not None:raise RuntimeError('Remote backup exists but local head absent; manual restore required')
            import uuid
            ledger=open_study(root,args.study_id,{})
            try:backup(root,ledger,'initial-'+uuid.uuid4().hex,remote)
            finally:ledger.db.close()
        return {'initialized':True,'study_id':args.study_id,'remote_marker_verified':True,'paid_calls':0}
    remote.verify_marker(m['study_id'])
    remote.verify_head(args.data_dir)
    if args.mode=='scheduled':
        import scheduler
        return scheduler.run(args.data_dir,m,remote)
    if args.mode=='diagnostic':
        if not args.action_id or not all(c.isalnum() or c in '-_' for c in args.action_id):raise RuntimeError('Stable diagnostic action ID required; never generate on restart')
        slot={'slot_id':'diagnostic:'+str(args.endpoint)+':'+args.action_id,'endpoint':args.endpoint,'intent_id':args.intent_id,'language':args.language}
    else:
        _,slots=runner.load_inputs(endpoint=args.endpoint)
        slot=next((s for s in slots if s['slot_id']==args.slot_id),None)
        if slot is None:raise RuntimeError('Frozen slot not found')
    return execute_one(args.data_dir,m,slot,'diagnostic' if args.mode=='diagnostic' else 'primary',backup_hook=remote)

def health_bind():
    value=os.environ.get("RESEARCH_HEALTH_BIND","127.0.0.1")
    if value not in ("127.0.0.1","0.0.0.0"):
        raise RuntimeError("Invalid research health bind")
    return value

def main():
    os.umask(0o077)
    ap=argparse.ArgumentParser();ap.add_argument('mode',choices=['idle','init','diagnostic','collect','scheduled'],nargs='?',default=os.environ.get('RESEARCH_ACTION','idle'))
    for flag,env,default in [('data-dir','RESEARCH_DATA_DIR','/data/research'),('study-id','RESEARCH_STUDY_ID',None),('manifest','RESEARCH_MANIFEST_PATH',None),('slot-id','RESEARCH_SLOT_ID',None),('endpoint','RESEARCH_ENDPOINT',None),('intent-id','RESEARCH_INTENT_ID',None),('language','RESEARCH_LANGUAGE',None),('action-id','RESEARCH_ACTION_ID',None)]:
        ap.add_argument('--'+flag,default=os.environ.get(env,default))
    ap.add_argument('--then-idle',action='store_true',default=os.environ.get('RESEARCH_THEN_IDLE')=='1');args=ap.parse_args()
    health_thread=None
    if args.then_idle or args.mode=='idle':
        import threading
        server=http.server.HTTPServer((health_bind(),8080),Health)
        health_thread=threading.Thread(target=server.serve_forever,daemon=True);health_thread.start()
    if args.mode!='idle':
        Health.state=args.mode
        try:print(json.dumps(perform(args)),flush=True)
        except Exception:
            # No raw exception, provider body or secret can reach container logs.
            print(json.dumps({'status':'blocked','action':args.mode,'paid_execution_enabled':False,'instruction':'Inspect private manifest/ledger; do not change action ID to bypass an unresolved attempt'}),flush=True)
            if not args.then_idle:raise SystemExit(2) from None
        Health.state='idle'
        if not args.then_idle:return
    print(json.dumps({'status':'idle','paid_execution_enabled':False,'health':health_bind()+':8080/healthz'}),flush=True)
    if health_thread:health_thread.join()

if __name__=='__main__':main()
