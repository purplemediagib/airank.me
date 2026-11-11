"""One reviewed operation per ephemeral hosted job. No init, resets or backfill."""
import argparse,json,os,pathlib,time
import core,service,storage,recovery

def run_round(root,m,prompts,slots,remote,round_id,deadline,clock=time.time,sleep=time.sleep,tick=service.tick):
    if round_id not in (1,2,3):raise ValueError('Explicit round required')
    window=next(w for w in m['rounds'] if w['round']==round_id)
    # Preserve full scientific window; do not silently shorten it to fit a host timeout.
    if core.utc_epoch(window['end_utc'])>deadline:raise RuntimeError('Whole round does not fit job deadline')
    if clock()>core.utc_epoch(window['start_utc'])+window['start_grace_seconds']:raise RuntimeError('Round missed; no backfill')
    while True:
        now=clock()
        if now>=deadline:return {'state':'job_deadline'}
        result=tick(root,m,prompts,slots,remote,now=now,selected_round=round_id,dispatch_deadline=deadline)
        if result['state'] in ('blocked','finished'):return result
        sleep(max(0,min(30,result.get('wake_at',clock())-clock())))

def main():
    os.umask(0o077)
    a=argparse.ArgumentParser();a.add_argument('operation',choices=['qualify','round','activate']);a.add_argument('--round',type=int);a.add_argument('--diagnostic-id');args=a.parse_args()
    # Job supplies a fixed deadline from its start, never reset after restore.
    deadline=float(os.environ['RESEARCH_JOB_DEADLINE_EPOCH'])
    if not time.time()<deadline<=time.time()+150*60:raise RuntimeError('Invalid finite job deadline')
    m,prompts,slots=service.load(str(pathlib.Path(__file__).parent/'manifest_RELEASE.json'))
    core.validate(m,prompts,slots,True,time.time(),args.operation=='qualify')
    remote=storage.from_env();root=pathlib.Path(os.environ['RESEARCH_DATA_DIR'])
    amendment=args.operation=='activate' and os.environ.get('RESEARCH_CLAUDE_REALLOCATION')=='approved-8-to-15'
    oa_amendment=args.operation=='activate' and os.environ.get('RESEARCH_OA_RECONCILIATION')=='approved-known-qualifier-estimate'
    restore_manifest=json.loads(core.canonical(m))
    if oa_amendment:restore_manifest['endpoints']['openai_api'].pop('accounting_mode',None)
    if amendment:
        restore_manifest['endpoints']['claude_api']['local_lifetime_cap_micro_usd']=8000000
        restore_manifest['manifest_sha256']=core.manifest_hash(restore_manifest)
    recovery.restore(root,restore_manifest,remote,os.environ['RESEARCH_EXPECTED_HEAD_SHA256'])
    if args.operation=='activate':
        result=service.activate(root,m,prompts,slots,remote,claude_reallocation=amendment,oa_reconciliation=oa_amendment)
    else:service.verify_inputs(root,m,prompts,slots)
    if args.operation=='round':result=run_round(root,m,prompts,slots,remote,args.round,deadline)
    elif args.operation=='qualify':
        slot=next((s for s in m['diagnostic_slots'] if s['slot_id']==args.diagnostic_id),None)
        if slot is None:raise RuntimeError('Approved diagnostic identity required')
        result=service.execute(root,m,prompts,slots,slot,'diagnostic',remote,dispatch_deadline=deadline)
    # No raw evidence or provider response printed. Full outcome lives in private snapshot.
    ledger=core.Ledger(root,m)
    try:summary=ledger.summary()
    finally:ledger.close()
    print(json.dumps({'state':result.get('state',result.get('status','activated' if result.get('activated') else None)),'paid_execution_attempted':args.operation!='activate','summary':summary,'accounted_micro_usd':result.get('accounted_micro_usd'),'cost_basis':result.get('cost_basis'),'answer_characters':result.get('answer_characters'),'citation_count':result.get('citation_count'),'diagnostic_facts':result.get('diagnostic_facts'),'next_expected_head_sha256':core.digest(core.canonical(remote.head()))}))
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'state':'blocked','error_type':type(e).__name__,'instruction':'Review private evidence; do not reset ledger.'}))
        raise SystemExit(2)
