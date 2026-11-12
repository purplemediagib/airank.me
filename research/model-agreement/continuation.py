"""Explicit R1 continuation. No reconciliation, reset, or retry of attempted slots."""
import argparse,json,os,pathlib,time,functools
import core,service,storage,recovery,cloud_driver,job_driver,adapters
from decimal import Decimal
ROOT=pathlib.Path(__file__).parent
POLICY='owner-approved-2026-11-12'
WINDOW={'round':1,'start_utc':'2026-11-12T19:00:00Z','end_utc':'2026-11-12T21:00:00Z','untouched_only':True}


RECONCILE_ATTEMPT=core.STUDY+':r1:GYM03:kimi_api:a1'
RECONCILE_RAW_SHA='6972d39acff7b7479bfc5d0e223f62f0e37d738d3347194d1a609a8fdd53050c'
RECONCILE_HEAD_SHA='38783006132248ea19402dd71dee0bd0f4880cda12e632e95f77a6c678fd801f'

def reconcile(root,m,prompts,slots,remote,now=None):
    """Exact known response only. Preserve raw receipt, original timing and immutable audit."""
    now=time.time() if now is None else now
    with core.locked(root):
        service.verify_inputs(root,m,prompts,slots);remote.verify(root,m)
        l=core.Ledger(root,m)
        try:
            auditpath=pathlib.Path(root)/'raw'/'kimi-GYM03-accounting-correction.json'
            if auditpath.exists():
                audit=json.loads(auditpath.read_bytes());r=l.db.execute('SELECT * FROM attempts WHERE id=?',(RECONCILE_ATTEMPT,)).fetchone()
                if audit.get('raw_sha256')!=RECONCILE_RAW_SHA or not r or r['status']!='complete' or r['accounted']!=20950 or l.summary()['unresolved'] or l.summary()['halted']:raise RuntimeError('Existing correction differs')
                return {'already_corrected':True,'paid_calls':0}
            if core.digest(core.canonical(remote.head()))!=RECONCILE_HEAD_SHA:raise RuntimeError('Unexpected reconciliation head')
            rows=l.rows();unknown=[r for r in rows if r['accounted'] is None]
            if len(rows)!=23 or len(unknown)!=1:raise RuntimeError('Unexpected reconciliation cohort')
            r=unknown[0]
            if r['id']!=RECONCILE_ATTEMPT or r['raw_hash']!=RECONCILE_RAW_SHA or r['endpoint']!='kimi_api' or r['status']!='unknown' or r['error']!='usage_or_cost_unverified':raise RuntimeError('Unexpected unresolved attempt')
            halt=l.db.execute("SELECT v FROM config WHERE k='halt'").fetchone()
            if not halt or halt[0]!='uncertain_or_excess_charge_or_fatal':raise RuntimeError('Unexpected halt')
            raw=(pathlib.Path(root)/r['raw_path']).read_bytes()
            if core.digest(raw)!=RECONCILE_RAW_SHA:raise RuntimeError('Receipt mismatch')
            receipt=json.loads(raw);response=receipt['response'];c=m['endpoints']['kimi_api']
            if receipt.get('attempt_id')!=RECONCILE_ATTEMPT or Decimal(str(response.get('usage',{}).get('cost'))) != Decimal('0.02094904'):raise RuntimeError('Receipt identity or cost differs')
            parsed=adapters.parse('kimi_api',response,c)
            if not parsed['complete'] or not parsed['answer'].strip():raise RuntimeError('Saved answer not complete')
            cost,basis=adapters.account('kimi_api',response,c,enforce_cost_bounds=False)
            if cost!=20950 or basis!='provider_reported_charge':raise RuntimeError('Unexpected charge calculation')
            audit={'kind':'verified_provider_charge_and_complete_answer_correction','attempt_before':r,'raw_sha256':RECONCILE_RAW_SHA,'previous_head_sha256':RECONCILE_HEAD_SHA,'provider_actual_usd':'0.02094904','ledger_rounded_up_micro_usd':cost,'rounding_note':'Ledger integer microUSD rounds up; raw provider actual retained','reason':'reported completion tokens include reasoning and exceeded qualified bound; provider cost present','at_epoch':now,'paid_calls':0}
            core.write_once(auditpath,core.canonical(audit))
            l.db.execute('BEGIN IMMEDIATE')
            try:
                l.db.execute("UPDATE attempts SET status='complete',accounted=?,cost_basis='provider_reported_charge_rounded_up_micro_usd',error=NULL WHERE id=?",(cost,RECONCILE_ATTEMPT))
                l.db.execute("DELETE FROM config WHERE k='halt'");l.db.execute('COMMIT')
            except Exception:l.db.execute('ROLLBACK');raise
            storage.backup(root,l,remote,m)
            return {'corrected':True,'paid_calls':0,'provider_actual_usd':'0.02094904','ledger_accounted_micro_usd':cost}
        finally:l.close()

def approved_manifest(old):
    new=json.loads(core.canonical(old));new['spend_safeguards_removed']=POLICY;new['continuation']=dict(WINDOW)
    for w in new['rounds']:
        if w['round']==1:w.update(start_utc=WINDOW['start_utc'],end_utc=WINDOW['end_utc'])
    new['manifest_sha256']=core.manifest_hash(new)
    return new

def inspect(root,m):
    # Never clears halted/unresolved flags. Separate evidence-backed reconciliation must finish first.
    info=cloud_driver.safe_ledger(root,m)
    l=core.Ledger(root,m)
    try:
        r=l.db.execute('SELECT * FROM rounds WHERE id=1').fetchone()
        if not r or r['state']!='active':raise RuntimeError('Only partially active R1 may continue')
        if l.db.execute('SELECT 1 FROM rounds WHERE id>1').fetchone():raise RuntimeError('Later round exists')
        rows=l.rows();primary=[r for r in rows if r['kind']=='primary']
        if not primary or any(not r['slot'].startswith(core.STUDY+':r1:') for r in primary):raise RuntimeError('Unexpected primary cohort')
        if any(r['status'] in ('reserved','fatal','unknown') or r['accounted'] is None for r in rows):raise RuntimeError('Attempt needs reconciliation')
        return rows
    finally:l.close()

def amend(root,old,new,prompts,slots,remote,now=None):
    now=time.time() if now is None else now
    if new!=approved_manifest(old):raise RuntimeError('Unapproved continuation change')
    if now>=core.utc_epoch(WINDOW['start_utc'])+600:raise RuntimeError('Continuation start window missed')
    core.validate(new,prompts,slots,True,now)
    with core.locked(root):
        service.verify_inputs(root,old,prompts,slots);remote.verify(root,old);before=inspect(root,old)
        l=core.Ledger(root,old)
        try:
            if l.db.execute("SELECT 1 FROM config WHERE k='continuation_amended'").fetchone():raise RuntimeError('Already amended')
            audit={'kind':'owner_approved_R1_20CET_continuation_no_monetary_caps','old_protocol':core.protocol_hash(old),'new_protocol':core.protocol_hash(new),'previous_head':core.digest(core.canonical(remote.head())),'preserved_attempts':len(before),'preserved_attempts_hash':core.digest(core.canonical(before)),'continuation':WINDOW,'previous_rounds':old['rounds'],'at_epoch':now,'paid_calls':0,'historical_caps_are_not_active_limits':True}
            core.write_once(pathlib.Path(root)/'raw'/'continuation-20261112.json',core.canonical(audit))
            remote.put_verified('study-marker-before-'+core.protocol_hash(old)+'.json',remote.get('study-marker.json'))
            remote.put_verified('study-marker.json',core.canonical({'study_id':core.STUDY,'provider_cap_micro_usd':new['provider_cap_micro_usd'],'protocol_sha256':core.protocol_hash(new)}),immutable=False)
            l.db.execute("UPDATE config SET v=? WHERE k='protocol_sha256'",(core.protocol_hash(new),))
            l.db.execute("INSERT INTO config VALUES ('continuation_amended',?)",(new['manifest_sha256'],))
            core.write_once(pathlib.Path(root)/'manifests'/(new['manifest_sha256']+'.json'),core.canonical(new))
            core.atomic(pathlib.Path(root)/'manifest.json',core.canonical(new))
            if l.rows()!=before:raise RuntimeError('Historical attempts changed')
            storage.backup(root,l,remote,new)
        finally:l.close()
    return {'amended':True,'paid_calls':0,'preserved_attempts':len(before)}

def run(root,m,prompts,slots,remote,deadline,clock=time.time,sleep=time.sleep,tick=service.tick):
    if m.get('continuation')!=WINDOW or m.get('spend_safeguards_removed')!=POLICY:raise RuntimeError('No approved continuation')
    if clock()>core.utc_epoch(WINDOW['start_utc'])+600:raise RuntimeError('Continuation start window missed')
    if deadline<core.utc_epoch(WINDOW['end_utc']) or deadline>clock()+9000:raise RuntimeError('Invalid finite deadline')
    with core.locked(root):
        service.verify_inputs(root,m,prompts,slots);remote.verify(root,m);inspect(root,m)
        l=core.Ledger(root,m)
        try:
            if l.db.execute("SELECT v FROM config WHERE k='continuation_amended'").fetchone()[0]!=m['manifest_sha256']:raise RuntimeError('Amendment differs')
            if l.db.execute("SELECT 1 FROM config WHERE k='continuation_started'").fetchone():raise RuntimeError('Continuation already attempted; no replay')
            l.db.execute("INSERT INTO config VALUES ('continuation_started',?)",(str(clock()),));storage.backup(root,l,remote,m)
        finally:l.close()
    return job_driver.run_round(root,m,prompts,slots,remote,1,deadline,clock,sleep,functools.partial(tick,untouched_only=True))

def verify_outcome(root,m,result,operation):
    cloud_driver.safe_ledger(root,m)
    if operation=='run':
        l=core.Ledger(root,m)
        try:r=l.db.execute('SELECT state FROM rounds WHERE id=1').fetchone()
        finally:l.close()
        if result.get('state')!='finished' or not r or r['state']!='complete':raise RuntimeError('Continuation did not complete')

def main():
    os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('operation',choices=['amend','run']);a=p.parse_args()
    if os.environ.get('RESEARCH_RELEASE_ENABLED')!='reviewed-and-enabled':raise RuntimeError('Release gate closed')
    old,prompts,slots=service.load(str(ROOT/'manifest_PRE_CONTINUATION.json'));new=json.loads((ROOT/'manifest_CONTINUATION.json').read_text())
    remote=storage.from_env();head=cloud_driver.verify_chain(remote);root=pathlib.Path(os.environ['RESEARCH_DATA_DIR'])
    current=old if a.operation=='amend' else new
    recovery.restore(root,current,remote,core.digest(core.canonical(head)))
    if a.operation=='amend':
        reconcile(root,old,prompts,slots,remote)
        result=amend(root,old,new,prompts,slots,remote)
    else:result=run(root,new,prompts,slots,remote,float(os.environ['RESEARCH_JOB_DEADLINE_EPOCH']))
    remote.verify(root,new);l=core.Ledger(root,new)
    try:summary=l.summary()
    finally:l.close()
    print(json.dumps({'state':result,'summary':summary,'monetary_caps_enabled':False,'next_expected_head_sha256':core.digest(core.canonical(remote.head()))}),flush=True)
    verify_outcome(root,new,result,a.operation)
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'state':'blocked','error_type':type(e).__name__,'instruction':'Inspect private evidence; never reset or replay.'}));raise SystemExit(2)
