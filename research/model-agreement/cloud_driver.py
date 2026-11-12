"""Finite cloud operations using existing secret, not browser credentials."""
import argparse,datetime,json,os,pathlib,time
import core,service,storage,recovery,job_driver
ROOT=pathlib.Path(__file__).parent
TRUSTED_ANCHOR='1640e0c71e6ccc3ca49db62f06ad7747b743c789406bc02bf0cfbd86fe7dfa25'

def verify_chain(remote,anchor=TRUSTED_ANCHOR):
    head=remote.head()
    if not head:raise RuntimeError('Missing private head')
    current=head;seen=set()
    for _ in range(2000):
        sha=core.digest(core.canonical(current))
        if sha==anchor:
            if remote.head()!=head:raise RuntimeError('Head changed during verification')
            return head
        if sha in seen:raise RuntimeError('Head cycle')
        seen.add(sha)
        if current.get('study_id')!=core.STUDY:raise RuntimeError('Wrong study in head chain')
        prev=current.get('previous_head_sha256','')
        if len(prev)!=64:raise RuntimeError('Head not descended from reviewed anchor')
        data=remote.get('head-'+prev+'.json')
        if data is None or core.digest(data)!=prev:raise RuntimeError('Missing or invalid head ancestor')
        prior=json.loads(data)
        if type(current.get('sequence'))!=int or current['sequence']!=prior.get('sequence',-2)+1:raise RuntimeError('Invalid head sequence')
        current=prior
    raise RuntimeError('Head chain limit exceeded')

def safe_ledger(root,m,round_id=None):
    ledger=core.Ledger(root,m)
    try:
        summary=ledger.summary()
        if summary['halted'] or summary['unresolved']:raise RuntimeError('Unresolved charges or halt')
        if m.get('spend_safeguards_removed')!='owner-approved-2026-11-12' and summary['committed_or_held_micro_usd']>m['provider_cap_micro_usd']:raise RuntimeError('Provider budget exceeded')
        for row in ledger.rows():
            if row['raw_path'] is None or row['raw_hash'] is None:raise RuntimeError('Receipt missing')
            p=pathlib.PurePosixPath(row['raw_path'])
            if len(p.parts)!=2 or p.parts[0]!='raw' or p.suffix!='.json':raise RuntimeError('Unsafe receipt path')
            if core.digest((pathlib.Path(root)/p).read_bytes())!=row['raw_hash']:raise RuntimeError('Receipt digest mismatch')
        rounds=[dict(r) for r in ledger.db.execute('SELECT * FROM rounds ORDER BY id')]
        if round_id is not None:
            if round_id not in (1,2,3):raise RuntimeError('Round required')
            if any(r['id']==round_id for r in rounds) or ledger.db.execute('SELECT 1 FROM attempts WHERE slot LIKE ?',(core.STUDY+':r'+str(round_id)+':%',)).fetchone():raise RuntimeError('Round already started; no replay')
            if any(not any(r['id']==n and r['state']=='complete' for r in rounds) for n in range(1,round_id)):raise RuntimeError('Prior round incomplete; review required')
        return {'summary':summary,'rounds':rounds}
    finally:ledger.close()

def amend_schedule(root,old,new,prompts,slots,remote,now=None):
    """Only explicitly approved round-one 4-hour shift, no scientific or budget changes."""
    old_slots=json.loads((ROOT/'inputs/schedule_PRE_2PM.json').read_text())
    expected_slots=json.loads(core.canonical(old_slots))
    for slot in expected_slots:
        if slot['round']!=1:continue
        slot['scheduled_at_utc']=(datetime.datetime.fromisoformat(slot['scheduled_at_utc'].replace('Z','+00:00'))+datetime.timedelta(hours=4)).isoformat().replace('+00:00','Z')
    if slots!=expected_slots:raise RuntimeError('Only exact round-one 4-hour slot shift permitted')
    expected=json.loads(core.canonical(old));expected['schedule_hash']=core.digest(core.canonical(slots));expected['execution_expires_at_utc']='2026-11-18T11:00:00Z'
    dates={1:'2026-11-12',2:'2026-11-14',3:'2026-11-18'}
    for w in expected['rounds']:
        if w!={'round':w['round'],'start_utc':dates[w['round']]+'T09:00:00Z','end_utc':dates[w['round']]+'T11:00:00Z','start_grace_seconds':600}:raise RuntimeError('Old windows differ')
        if w['round']==1:w['start_utc']=dates[1]+'T13:00:00Z';w['end_utc']=dates[1]+'T15:00:00Z'
    expected['manifest_sha256']=core.manifest_hash(expected)
    if new!=expected:raise RuntimeError('Unapproved schedule amendment')
    core.validate(new,prompts,slots,True,time.time() if now is None else now)
    with core.locked(root):
        service.verify_inputs(root,old,prompts,old_slots);remote.verify(root,old);info=safe_ledger(root,old);ledger=core.Ledger(root,old)
        try:
            if info['rounds'] or ledger.db.execute("SELECT 1 FROM attempts WHERE kind='primary'").fetchone():raise RuntimeError('Primary work exists; do not reschedule')
            audit={'kind':'owner_approved_round1_2pm_Gibraltar_schedule','prior_head_sha256':core.digest(core.canonical(remote.head())),'old_manifest_sha256':old['manifest_sha256'],'new_manifest_sha256':new['manifest_sha256'],'old_rounds':old['rounds'],'new_rounds':new['rounds'],'old_schedule':old_slots,'new_schedule_hash':new['schedule_hash'],'prior_attempts_retained':info['summary']['attempts'],'approved_total_micro_usd':40000000,'at_epoch':time.time() if now is None else now}
            core.write_once(pathlib.Path(root)/'raw'/'schedule-round1-2pm-amendment.json',core.canonical(audit))
            remote.put_verified('study-marker-before-'+core.protocol_hash(old)+'.json',remote.get('study-marker.json'))
            remote.put_verified('study-marker.json',core.canonical({'study_id':core.STUDY,'provider_cap_micro_usd':new['provider_cap_micro_usd'],'protocol_sha256':core.protocol_hash(new)}),immutable=False)
            ledger.db.execute("UPDATE config SET v=? WHERE k='protocol_sha256'",(core.protocol_hash(new),))
            core.write_once(pathlib.Path(root)/'manifests'/(new['manifest_sha256']+'.json'),core.canonical(new));core.atomic(pathlib.Path(root)/'manifest.json',core.canonical(new));core.atomic(pathlib.Path(root)/'schedule.json',core.canonical(slots))
            storage.backup(root,ledger,remote,new)
        finally:ledger.close()
    return {'schedule_amended':True,'paid_calls':0}

def prepare(root,m,prompts,slots,remote,operation,round_id=None,anchor=TRUSTED_ANCHOR,now=None):
    head=verify_chain(remote,anchor);old=json.loads((ROOT/'manifest_PRE_2PM.json').read_text())
    restore_m=old if head['protocol_sha256']==core.protocol_hash(old) else m
    restore_slots=json.loads((ROOT/'inputs/schedule_PRE_2PM.json').read_text()) if restore_m==old else slots
    recovery.restore(root,restore_m,remote,core.digest(core.canonical(head)));service.verify_inputs(root,restore_m,prompts,restore_slots)
    if operation=='reschedule':
        if restore_m==m:raise RuntimeError('Schedule already amended; no repeated write')
        return amend_schedule(root,old,m,prompts,slots,remote,now)
    if restore_m!=m:raise RuntimeError('Approved reschedule must complete first')
    core.validate(m,prompts,slots,True,time.time() if now is None else now)
    return safe_ledger(root,m,round_id)

def main():
    os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('operation',choices=['preflight','reschedule','round']);p.add_argument('--round',type=int);a=p.parse_args()
    if os.environ.get('RESEARCH_RELEASE_ENABLED')!='reviewed-and-enabled':raise RuntimeError('Release gate closed')
    remote=storage.from_env();path=ROOT/'manifest_RELEASE.json'
    continuation_path=ROOT/'manifest_CONTINUATION.json'
    if continuation_path.exists():
        candidate=json.loads(continuation_path.read_bytes());head=remote.head()
        if head and head.get('protocol_sha256')==core.protocol_hash(candidate):path=continuation_path
    m,prompts,slots=service.load(str(path));root=pathlib.Path(os.environ['RESEARCH_DATA_DIR'])
    result=prepare(root,m,prompts,slots,remote,a.operation,a.round)
    if a.operation=='round':
        deadline=float(os.environ['RESEARCH_JOB_DEADLINE_EPOCH'])
        if not time.time()<deadline<=time.time()+150*60:raise RuntimeError('Invalid finite deadline')
        result=job_driver.run_round(root,m,prompts,slots,remote,a.round,deadline)
    remote.verify(root,m)
    ledger=core.Ledger(root,m)
    try:info={'summary':ledger.summary(),'rounds':[dict(r) for r in ledger.db.execute('SELECT * FROM rounds ORDER BY id')]}
    finally:ledger.close()
    print(json.dumps({'state':result.get('state','verified'),'paid_execution_attempted':a.operation=='round','summary':info['summary'],'rounds':info['rounds'],'next_expected_head_sha256':core.digest(core.canonical(remote.head()))}),flush=True)
    safe_ledger(root,m)
    if a.operation=='round' and (result.get('state')!='finished' or not any(r['id']==a.round and r['state']=='complete' for r in info['rounds'])):raise RuntimeError('Round did not complete')
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'state':'blocked','error_type':type(e).__name__,'instruction':'Inspect private evidence; never reset or replay.'}));raise SystemExit(2)
