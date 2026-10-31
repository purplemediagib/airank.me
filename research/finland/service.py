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
    init_stage('backup_snapshot')
    root=pathlib.Path(root);dest=root/'backups'/f'{tag}.sqlite'
    if dest.exists():raise RuntimeError('Backup already exists')
    with sqlite3.connect(dest) as target:ledger.db.backup(target)
    archive=root/'backups'/f'{tag}.tar.gz'
    with tarfile.open(archive,'x:gz') as tar:
        tar.add(dest,arcname='ledger.sqlite');tar.add(root/'identity.json',arcname='identity.json');tar.add(root/'raw',arcname='raw');tar.add(root/'manifests',arcname='manifests');tar.add(runner.ROOT/'inputs',arcname='inputs')
    digest=runner.digest(archive.read_bytes()); result={'path':str(archive),'sha256':digest,'created_at':utc()}
    if hook:
        init_stage('backup_remote_verify')
        ack=hook(archive,digest)
        if not isinstance(ack,dict) or ack.get('verified') is not True or ack.get('sha256')!=digest or not ack.get('reference'):raise RuntimeError('Private backup not verified')
        result['remote']=ack
    init_stage('backup_local_receipt')
    write_once(root/'backups'/f'{tag}.json',result)
    if hook and getattr(hook,'delete_local_after_verified',False):
        # Only redundant local snapshots are removed, after verified private remote upload/head.
        # Primary raw evidence and durable ledger remain untouched.
        init_stage('backup_local_cleanup')
        dest.unlink();archive.unlink()
    return result

def manifest_hash(m):
    return runner.digest(json.dumps({k:v for k,v in m.items() if k!='frozen_manifest_sha256'},sort_keys=True,separators=(',',':')).encode())

def execution_gate(m,kind):
    if runner.sanitize(m)!=m:raise RuntimeError('Manifest must not contain credentials')
    common=['owner_execution_approved','secure_host_verified','durable_storage_verified','private_backup_verified','all_billable_bounds_verified']
    if kind=='primary':
        common+=['finnish_review_signed','protocol_frozen','models_qualified']
        if m.get('location_policy_version')!='finland-v1':raise RuntimeError('Primary location method not frozen')
    else:common+=['diagnostics_approved']
    missing=[k for k in common if m.get(k) is not True]
    if missing:raise RuntimeError('Execution gates closed: '+', '.join(missing))
    if m.get('provider_budget_usd')!=38 or m.get('hosting_budget_usd')!=2:raise RuntimeError('Budget allocation mismatch')
    if m.get('input_hashes')!=runner.hashes():raise RuntimeError('Inputs not frozen to this image')
    if not m.get('study_id'):raise RuntimeError('Study identity absent')
    if m.get('frozen_manifest_sha256')!=manifest_hash(m):raise RuntimeError('Provider settings/bounds manifest hash mismatch')

LOCATION_POLICY_VERSION='finland-v1'
LOCATION_CITIES={'ACC04':'Tampere','IT04':'Turku','MKT04':'Helsinki'}
def requested_location(endpoint,intent_id):
    if endpoint!='openai_responses':return None  # Exa search has no supported user_location.
    value={'type':'approximate','country':'FI'}
    if intent_id in LOCATION_CITIES:value['city']=LOCATION_CITIES[intent_id]
    return value

def location_matches(response,expected):
    tools=[x for x in response.get('tools',[]) if isinstance(x,dict) and x.get('type')=='web_search']
    if not tools:return False
    return all(isinstance(x.get('user_location'),dict) and all(x['user_location'].get(k)==v for k,v in expected.items()) for x in tools)

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
    location=requested_location(endpoint,slot['intent_id']) if m.get('location_policy_version')==LOCATION_POLICY_VERSION else None
    if endpoint=='openai_responses' and location is not None:dispatch_config['search_parameters']={**config.get('search_parameters',{}),'user_location':location}
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
            evidence={'manifest_sha256':m['frozen_manifest_sha256'],'requested_settings':runner.sanitize(dispatch_config),'location_policy_version':m.get('location_policy_version'),'requested_search_location':location,'location_support':'supported' if endpoint=='openai_responses' else 'unsupported_exa','study_id':m['study_id'],'slot':slot,'attempt_id':aid,'started_at':started,'ended_at':datetime.datetime.fromtimestamp(response_end,datetime.timezone.utc).isoformat(),'prompt_hash':runner.digest(prompt.encode()),'requested_model':config.get('model'),'response':runner.sanitize(response)}
            raw_hash=write_once(pathlib.Path(root)/'raw'/f'{tag}.json',evidence)
            # Provider costs must be verified all-in; absent/uncertain usage retains full hold and stops execution.
            import accounting
            charge=accounting.cost(response,endpoint,config)
            actual=charge['actual'];accounted=charge['accounted']
            complete=(runner.parse_response(response)['usable'] if endpoint=='openai_responses' else bool(response.get('choices')) and all(c.get('finish_reason') in ('stop',) for c in response['choices']))
            status=('complete' if complete else 'incomplete') if actual is not None or accounted is not None else 'unknown'
            if kind=='primary' and endpoint=='openai_responses' and not location_matches(response,location):status='fatal'
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

INIT_STAGE='not_started'
def init_stage(value):
    global INIT_STAGE
    INIT_STAGE=value

def safe_failure(exc,args):
    # Only fixed codes, booleans and nonsecret inline-manifest length; never exception strings.
    inline=os.environ.get('RESEARCH_MANIFEST_JSON','')
    out={'failure_stage':INIT_STAGE,'failure_code':'unclassified','environment_present':{name:bool(os.environ.get(name)) for name in ('RESEARCH_MANIFEST_JSON','RESEARCH_MANIFEST_PATH','RESEARCH_STUDY_ID','RESEARCH_STORAGE_HOST','RESEARCH_STORAGE_ZONE','RESEARCH_STORAGE_ACCESS_KEY')},'manifest_json_length':len(inline)}
    if isinstance(exc,json.JSONDecodeError):out['failure_code']='manifest_json_invalid' if INIT_STAGE=='manifest_load' else 'json_invalid'
    elif isinstance(exc,PermissionError):out['failure_code']='filesystem_permission_denied'
    elif isinstance(exc,FileNotFoundError):out['failure_code']='required_file_missing'
    elif isinstance(exc,sqlite3.Error):out['failure_code']='sqlite_failure'
    try:
        m=json.loads(inline)
        out['manifest_hash_matches']=isinstance(m,dict) and m.get('frozen_manifest_sha256')==manifest_hash(m)
        out['study_id_matches']=isinstance(m,dict) and args.study_id==m.get('study_id')
        value=m.get('study_id') if isinstance(m,dict) else None
        out['study_id_valid']=isinstance(value,str) and bool(value) and all(c.isalnum() or c in '-_.' for c in value)
        out['storage_access_approved']=isinstance(m,dict) and m.get('storage_access_approved') is True
    except Exception:out['manifest_hash_matches']=False
    import storage
    if isinstance(exc,storage.StorageError):
        out['failure_code']='private_storage_failure'
        out['storage_stage']=storage.LAST_STAGE
        if exc.http_status is not None:out['storage_http_status']=exc.http_status
        if exc.operation is not None:out['storage_operation']=exc.operation
    return out


def diagnostic_preflight(root,m,remote):
    """Read source files under existing locks; all SQLite/report work is on a disposable copy."""
    import shutil
    root=pathlib.Path(root)
    result={'status':'diagnostic_preflight_complete','paid_calls':0,'storage_writes':0,'persistent_research_writes':0,'ephemeral_snapshot_used':True}
    init_stage('probe_existing_locks')
    with contextlib.ExitStack() as stack:
        for name in ('runner.lock','qualification.lock'):
            handle=stack.enter_context((root/name).open('rb'))
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        init_stage('probe_marker_get')
        marker=remote.read_marker()
        result['remote_marker_matches']=isinstance(marker,dict) and marker.get('study_id')==m['study_id'] and marker.get('provider_cap_micro_usd')==38000000
        init_stage('probe_head_get')
        head=remote.head()
        init_stage('probe_local_head_read')
        local=json.loads((root/'remote-head.json').read_text())
        result['remote_local_head_equal']=head==local
        result['remote_head_sequence']=head.get('sequence') if isinstance(head,dict) and type(head.get('sequence')) is int else None
        init_stage('probe_disposable_snapshot')
        with tempfile.TemporaryDirectory(prefix='research-readonly-probe-') as tmp:
            copy=pathlib.Path(tmp)/'snapshot'
            # Never copy keys/environment or modify source. Existing lock forbids active writers.
            copy.mkdir()
            for name in ('identity.json','ledger.sqlite','ledger.sqlite-wal','ledger.sqlite-shm'):
                if (root/name).is_file():shutil.copyfile(root/name,copy/name)
            for name in ('raw','manifests'):
                shutil.copytree(root/name,copy/name)
            init_stage('probe_snapshot_integrity')
            with sqlite3.connect(copy/'ledger.sqlite') as db:
                result['ledger_integrity_ok']=db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
                fingerprint=hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()
                result['ledger_matches_remote_head']=isinstance(head,dict) and fingerprint==head.get('ledger_fingerprint')
                result['ledger_matches_local_head']=fingerprint==local.get('ledger_fingerprint')
                result['ledger_halted']=bool(db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone())
                row=db.execute('SELECT id FROM attempts ORDER BY start DESC LIMIT 1').fetchone()
            if row:
                tag=hashlib.sha256(row[0].encode()).hexdigest()
                result['last_finished_receipt_present']=(root/'backups'/f'{tag}-finished.json').is_file()
                result['last_finished_snapshot_present']=(root/'backups'/f'{tag}-finished.sqlite').is_file()
                result['last_finished_archive_present']=(root/'backups'/f'{tag}-finished.tar.gz').is_file()
            init_stage('probe_report_build')
            import qualification
            captured={}
            class Capture:
                def put_verified(self,name,payload):
                    captured.update(name=name,payload=payload)
                    return {'verified':True,'sha256':runner.digest(payload)}
            data,name=qualification.report(copy,m,Capture())
            result['diagnostic_attempts']=data['budget']['diagnostic_attempts']
            result['committed_or_held_micro_usd']=data['budget']['committed_or_held_micro_usd']
            result['uncertain_charge_hold_micro_usd']=data['budget']['uncertain_charge_hold_micro_usd']
            result['batch_attempts']=len(data['attempts'])
            result['batch_evidence_stop_count']=sum(bool(x.get('stop_reason')) for x in data['attempts'])
            init_stage('probe_report_get')
            status,payload=remote.transport('GET',remote.base+name)
            result['report_storage_http_status']=status if type(status) is int and 100<=status<=599 else None
            result['report_present']=status==200
            result['report_bytes_match']=payload==captured['payload'] if status==200 else None
            result['report_file']=name
    return result

def perform(args):
    init_stage('manifest_load')
    if args.manifest:m=json.loads(pathlib.Path(args.manifest).read_text())
    elif os.environ.get('RESEARCH_MANIFEST_JSON'):m=json.loads(os.environ['RESEARCH_MANIFEST_JSON'])
    else:raise RuntimeError('Explicit reviewed manifest required')
    init_stage('manifest_validation')
    if m.get('storage_access_approved') is not True:raise RuntimeError('Private storage access not approved')
    if m.get('frozen_manifest_sha256')!=manifest_hash(m):raise RuntimeError('Manifest hash mismatch')
    import storage
    init_stage('storage_configuration')
    remote=storage.from_env(m['study_id'])
    if args.mode=='diagnostic_preflight':
        if args.study_id!=m['study_id']:raise RuntimeError('Study ID differs from manifest')
        return diagnostic_preflight(args.data_dir,m,remote)
    if args.mode=='preflight':
        init_stage('study_id_validation')
        if args.study_id!=m['study_id']:raise RuntimeError('Study ID differs from manifest')
        init_stage('remote_marker_read')
        prior=remote.read_marker()
        root=pathlib.Path(args.data_dir)
        return {'status':'preflight_passed','paid_calls':0,'storage_writes':0,'local_writes':0,'remote_marker_present':prior is not None,'local_identity_present':(root/'identity.json').is_file(),'local_ledger_present':(root/'ledger.sqlite').is_file(),'local_head_present':(root/'remote-head.json').is_file(),'note':'Read-only checks only; not initialization or durability proof'}
    if args.mode=='init':
        init_stage('study_id_validation')
        if args.study_id!=m['study_id']:raise RuntimeError('Study ID differs from manifest')
        root=pathlib.Path(args.data_dir)
        init_stage('remote_marker_read');prior=remote.read_marker()
        init_stage('local_identity_check')
        if (root/'identity.json').exists():
            ledger=open_study(root,args.study_id,{})
            try:
                if ledger.rows():raise RuntimeError('Existing attempt history; initialization forbidden')
            finally:ledger.db.close()
        else:
            if prior is not None:raise RuntimeError('Remote study exists but local identity absent; restore backup')
            init_stage('local_ledger_initialize')
            initialize(root,args.study_id)
        identity=json.loads((root/'identity.json').read_text())
        init_stage('remote_marker_verify')
        remote.ensure_marker(identity)
        init_stage('remote_head_check')
        if (root/'remote-head.json').exists():remote.verify_head(root)
        else:
            if remote.head() is not None:raise RuntimeError('Remote backup exists but local head absent; manual restore required')
            import uuid
            ledger=open_study(root,args.study_id,{})
            init_stage('initial_backup_verify')
            try:backup(root,ledger,'initial-'+uuid.uuid4().hex,remote)
            finally:ledger.db.close()
        return {'initialized':True,'study_id':args.study_id,'remote_marker_verified':True,'paid_calls':0}
    init_stage('execution_marker_verify');remote.verify_marker(m['study_id'])
    init_stage('execution_head_verify');remote.verify_head(args.data_dir)
    if args.mode=='diagnostic_batch':
        import qualification
        return qualification.run(args.data_dir,m,remote)
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
    ap=argparse.ArgumentParser();ap.add_argument('mode',choices=['idle','preflight','diagnostic_preflight','init','diagnostic','diagnostic_batch','collect','scheduled'],nargs='?',default=os.environ.get('RESEARCH_ACTION','idle'))
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
        except Exception as exc:
            # No raw exception, provider body or secret can reach container logs.
            print(json.dumps({'status':'blocked','action':args.mode,'paid_execution_enabled':False,'instruction':'Inspect private manifest/ledger; do not change action ID to bypass an unresolved attempt',**(safe_failure(exc,args) if args.mode in ('init','preflight','diagnostic_preflight','diagnostic_batch') else {})}),flush=True)
            if not args.then_idle:raise SystemExit(2) from None
        Health.state='idle'
        if not args.then_idle:return
    print(json.dumps({'status':'idle','paid_execution_enabled':False,'health':health_bind()+':8080/healthz'}),flush=True)
    if health_thread:health_thread.join()

if __name__=='__main__':main()
