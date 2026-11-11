"""Isolated three-route runner. Defaults idle. No secrets loaded except explicit execution."""
import argparse,datetime,json,os,pathlib,time
import adapters,core,storage
ROOT=pathlib.Path(__file__).parent

def load(manifest):
    m=json.loads(pathlib.Path(manifest).read_text());prompts=json.loads((ROOT/'inputs/prompts.json').read_text());slots=json.loads((ROOT/'inputs/schedule_DRAFT.json').read_text());core.validate(m,prompts,slots);return m,prompts,slots

def check_root(root):
    root=pathlib.Path(root)
    if root.name!=core.STUDY or 'finland-language-v02' in str(root):raise RuntimeError('Use a distinct model-agreement-v01 data directory')
    return root

def init(root,m,prompts,slots,remote):
    root=check_root(root)
    if root.exists() and any(root.iterdir()):raise RuntimeError('Existing study directory; never initialize/reset')
    core.validate(m,prompts,slots)
    if m.get('storage_setup_approved') is not True:raise RuntimeError('Storage setup approval absent')
    if remote.get('study-marker.json') is not None or remote.head() is not None:raise RuntimeError('Remote study exists; restore required')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    core.write_once(root/'identity.json',core.canonical({'study_id':core.STUDY,'manifest_sha256':m['manifest_sha256']}))
    for name,x in [('manifest.json',m),('prompts.json',prompts),('schedule.json',slots)]:core.write_once(root/name,core.canonical(x))
    core.write_once(root/'manifests'/(m['manifest_sha256']+'.json'),core.canonical(m))
    with core.locked(root):
        ledger=core.Ledger(root,m,True)
        try:remote.initialize_marker(m);head=storage.backup(root,ledger,remote,m,True)
        finally:ledger.close()
    return {'initialized':True,'head_sequence':head['sequence'],'paid_calls':0}

def verify_inputs(root,m,prompts,slots):
    for name,obj in [('manifest.json',m),('prompts.json',prompts),('schedule.json',slots)]:
        if (pathlib.Path(root)/name).read_bytes()!=core.canonical(obj):raise RuntimeError('Local frozen inputs differ')

def activate(root,new,prompts,slots,remote,now=None):
    """Explicit qualification->primary transition. Never resets ledger, prices or study history."""
    root=check_root(root);old=json.loads((root/'manifest.json').read_text())
    core.validate(old,prompts,slots);core.validate(new,prompts,slots,True,time.time() if now is None else now,False)
    if old.get('schedule_enabled') is True:raise RuntimeError('Already activated; no schedule amendment here')
    if core.protocol_hash(old)!=core.protocol_hash(new):raise RuntimeError('Activation cannot alter immutable protocol/routes/budget')
    if new.get('qualification_review_approved') is not True or new.get('qualification_enabled') is not False:raise RuntimeError('Qualification review/closure required')
    with core.locked(root):
        verify_inputs(root,old,prompts,slots);remote.verify(root,old);ledger=core.Ledger(root,old)
        try:
            if ledger.summary()['halted'] or ledger.summary()['unresolved']:raise RuntimeError('Unresolved qualification')
            for ep in core.ENDPOINTS:
                expected=[s for s in old.get('diagnostic_slots',[]) if s['endpoint']==ep]
                if not expected:raise RuntimeError('No qualification slots for endpoint')
                for slot in expected:
                    row=ledger.db.execute('SELECT * FROM attempts WHERE slot=?',(slot['slot_id'],)).fetchone()
                    if not row or row['status']!='complete' or row['accounted'] is None:raise RuntimeError('Qualification evidence incomplete')
            core.write_once(root/'manifests'/(new['manifest_sha256']+'.json'),core.canonical(new))
            core.atomic(root/'manifest.json',core.canonical(new))
            storage.backup(root,ledger,remote,new)
            return {'activated':True,'paid_calls':0,'prior_attempts_retained':ledger.summary()['attempts']}
        finally:ledger.close()

def execute(root,m,prompts,slots,slot,kind,remote,transport=adapters.http,clock=time.time,key_loader=None):
    now=clock();qualification=kind=='diagnostic';core.validate(m,prompts,slots,True,now,qualification)
    root=check_root(root);ep=slot['endpoint'];c=m['endpoints'][ep]
    if kind=='primary' and slot not in slots:raise RuntimeError('Unknown primary slot')
    if kind=='diagnostic':
        approved=m.get('diagnostic_slots',[])
        if slot not in approved or not slot['slot_id'].startswith(core.STUDY+':diagnostic:'):raise RuntimeError('Unapproved diagnostic slot')
    prompt=next(p['text'] for p in prompts if p['prompt_id']==slot['prompt_id'])
    with core.locked(root):
        verify_inputs(root,m,prompts,slots);remote.verify(root,m);ledger=core.Ledger(root,m)
        try:
            # Credentials checked before reservation; their values never enter raw evidence/logs.
            key=(key_loader or os.environ.get)(adapters.KEYS[ep])
            if not key:raise RuntimeError('Missing provider credential for '+ep)
            aid=ledger.claim(slot['slot_id'],ep,kind,c['reservation_micro_usd'],m,now)
            storage.backup(root,ledger,remote,m)  # durable reservation before any request
            started=clock()
            # Storage upload/readback may be slow. Recheck immediately before the paid dispatch.
            deadline=core.utc_epoch(m['execution_expires_at_utc'])
            if kind=='primary':
                window=next(w for w in m['rounds'] if w['round']==slot['round'])
                deadline=min(deadline,core.utc_epoch(window['end_utc']))
                too_early=started<core.utc_epoch(window['start_utc'])
            else:too_early=False
            if too_early or started+c['timeout_seconds']>=deadline:
                rawpath='raw/'+core.digest(aid.encode())+'.json'
                sha=core.write_once(root/rawpath,core.canonical({'attempt_id':aid,'slot':slot,'error':'dispatch_window_expired_before_request','provider_request_sent':False,'ended_at_epoch':started}))
                ledger.finish(aid,'fatal',rawpath,sha,0,'known_no_provider_request',started,'dispatch_window_expired_before_request')
                storage.backup(root,ledger,remote,m)
                return {'attempt_id':aid,'status':'blocked','reason':'dispatch_window_expired_before_request','provider_request_sent':False,'accounted_micro_usd':0}
            try:r=adapters.request(ep,prompt,c,key,transport)
            except adapters.ProviderError as e:
                # No trustworthy response/charge: retain reservation and HALT, even a transport-retryable error.
                raw={'attempt_id':aid,'slot':slot,'started_at_epoch':started,'ended_at_epoch':clock(),'error':e.category}
                rawpath='raw/'+core.digest(aid.encode())+'.json';sha=core.write_once(root/rawpath,core.canonical(raw))
                ledger.finish(aid,'retryable' if e.category in ('timeout','429','5xx') else 'fatal',rawpath,sha,None,'unresolved_charge',clock(),e.category,e.retry_after)
                storage.backup(root,ledger,remote,m)
                return {'attempt_id':aid,'status':'blocked','reason':e.category,'charge_hold_retained':True}
            finally:key=None
            ended=clock();raw={'study_id':core.STUDY,'manifest_sha256':m['manifest_sha256'],'attempt_id':aid,'slot':slot,'started_at_epoch':started,'ended_at_epoch':ended,'prompt_hash':core.digest(prompt.encode()),'requested_settings':core.sanitize(c),'requested_location':c.get('requested_location'),'location_support':c.get('location_support','unverified'),'response':core.sanitize(r)}
            rawpath='raw/'+core.digest(aid.encode())+'.json';sha=core.write_once(root/rawpath,core.canonical(raw))
            # Parse and account independently: a semantic/provenance failure must not erase known spend.
            accounted=None;basis='unresolved_charge';status='unknown';error=None;parsed=None
            try:accounted,basis=adapters.account(ep,r,c)
            except (ValueError,KeyError,TypeError):error='usage_or_cost_unverified'
            try:
                parsed=adapters.parse(ep,r,c)
                status='complete' if parsed['complete'] else 'incomplete'
            except (RuntimeError,ValueError,TypeError,KeyError):status='fatal';error='response_provenance_or_shape_invalid'
            if accounted is None:status='unknown'
            ledger.finish(aid,status,rawpath,sha,accounted,basis,ended,error)
            storage.backup(root,ledger,remote,m)
            return {'attempt_id':aid,'status':status,'accounted_micro_usd':accounted,'cost_basis':basis,'raw_sha256':sha,'answer_characters':len(parsed['answer']) if parsed else None}
        finally:ledger.close()

def tick(root,m,prompts,slots,remote,now=None,execute_fn=execute,**kwargs):
    now=time.time() if now is None else now;core.validate(m,prompts,slots,True,now,False)
    chosen=None
    with core.locked(root):
        verify_inputs(root,m,prompts,slots);remote.verify(root,m);ledger=core.Ledger(root,m)
        try:
            summary=ledger.summary()
            if summary['halted'] or summary['unresolved']:return {'state':'blocked','reason':'unresolved_charge_or_halt'}
            for window in sorted(m['rounds'],key=lambda r:r['round']):
                start,end=core.utc_epoch(window['start_utc']),core.utc_epoch(window['end_utc']);n=window['round']
                state=ledger.db.execute('SELECT * FROM rounds WHERE id=?',(n,)).fetchone()
                if state and state['state'] in ('complete','missed','expired'):continue
                if now<start:return {'state':'waiting','wake_at':start}
                if not state and now>start+window['start_grace_seconds']:
                    ledger.db.execute('INSERT INTO rounds VALUES (?,?,?,?,?)',(n,'missed',None,now,'no_backfill'));storage.backup(root,ledger,remote,m);continue
                if now>=end:
                    ledger.db.execute('INSERT OR REPLACE INTO rounds VALUES (?,?,?,?,?)',(n,'expired',state['start'] if state else None,now,'window_expired'));storage.backup(root,ledger,remote,m);continue
                if not state:
                    ledger.db.execute('INSERT INTO rounds VALUES (?,?,?,?,?)',(n,'active',now,None,None));storage.backup(root,ledger,remote,m)
                for slot in (s for s in slots if s['round']==n):
                    prior=ledger.db.execute('SELECT * FROM attempts WHERE slot=? ORDER BY n',(slot['slot_id'],)).fetchall()
                    if not prior:chosen=slot;break
                    last=prior[-1]
                    if last['status']=='retryable' and len(prior)==1:
                        if now<last['retry_at']:return {'state':'waiting_retry','wake_at':last['retry_at']}
                        chosen=slot;break
                    if last['status'] in ('reserved','fatal','unknown'):return {'state':'blocked','reason':'slot_requires_review'}
                if chosen is not None:
                    timeout=m['endpoints'][chosen['endpoint']]['timeout_seconds']
                    if now+timeout>=end:return {'state':'waiting','wake_at':end}
                    break
                ledger.db.execute('UPDATE rounds SET state=?,end=? WHERE id=?',('complete',now,n));storage.backup(root,ledger,remote,m)
            if chosen is None:return {'state':'finished','summary':ledger.summary()}
        finally:ledger.close()
    return {'state':'attempted','result':execute_fn(root,m,prompts,slots,chosen,'primary',remote,**kwargs)}

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser();p.add_argument('action',choices=['idle','validate','init','preflight','qualify','activate','scheduled'],nargs='?',default=os.environ.get('RESEARCH_ACTION','idle'));p.add_argument('--manifest',default=os.environ.get('RESEARCH_MANIFEST_PATH',str(ROOT/'manifest_DRAFT.json')));p.add_argument('--root',default=os.environ.get('RESEARCH_DATA_DIR','/data/'+core.STUDY));p.add_argument('--diagnostic-id',default=os.environ.get('RESEARCH_DIAGNOSTIC_ID'));a=p.parse_args()
    if a.action=='idle':print(json.dumps({'state':'idle','paid_calls':0,'hosting_still_bills':True}));return
    m,prompts,slots=load(a.manifest)
    if a.action=='validate':print(json.dumps({'valid_offline':True,'paid_calls':0}));return
    remote=storage.from_env()
    if a.action=='init':result=init(a.root,m,prompts,slots,remote)
    elif a.action=='activate':result=activate(a.root,m,prompts,slots,remote)
    elif a.action=='preflight':
        remote.verify(a.root,m);verify_inputs(a.root,m,prompts,slots)
        result={'preflight':'storage_and_inputs_verified','paid_calls':0,'live_gates_not_validated':True}
    elif a.action=='qualify':
        slot=next((s for s in m.get('diagnostic_slots',[]) if s['slot_id']==a.diagnostic_id),None)
        if not slot:raise RuntimeError('Explicit approved diagnostic id required')
        result=execute(a.root,m,prompts,slots,slot,'diagnostic',remote)
    else:
        while True:
            result=tick(a.root,m,prompts,slots,remote)
            print(json.dumps(result),flush=True)
            if result['state'] in ('blocked','finished'):break
            time.sleep(max(0,min(60,result.get('wake_at',time.time())-time.time())))
    print(json.dumps(result),flush=True)
if __name__=='__main__':
    try:main()
    except Exception as e:
        # Fixed error category only: no response, secret, or exception content logged.
        print(json.dumps({'state':'blocked','error_type':type(e).__name__,'instruction':'Inspect private study evidence; do not reset ledger or IDs.'}),flush=True)
        raise SystemExit(2)
