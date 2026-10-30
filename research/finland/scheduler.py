"""Frozen six-block scheduler. No network/import-time activity; action off by default."""
import datetime,json,time,uuid
import runner,service

def epoch(slot):
    return datetime.datetime.fromisoformat(slot['proposed_date_utc']+'T'+slot['proposed_block_utc']+':00+00:00').timestamp()
def block_id(slot):return slot['proposed_date_utc']+'T'+slot['proposed_block_utc']+'Z'
def schedule():
    # Preserve original interleaving/randomization and adjacent language pairs from frozen v0.2 file.
    rows=json.loads((runner.ROOT/'inputs'/'schedule_v02_openai_kimi_DRAFT.json').read_text())
    assert len(rows)==288 and len({s['slot_id'] for s in rows})==288
    return rows

def schema(ledger):
    ledger.db.executescript('''CREATE TABLE IF NOT EXISTS scheduled_blocks(id TEXT PRIMARY KEY,state TEXT,started REAL,ended REAL,reason TEXT);
    CREATE TABLE IF NOT EXISTS paired_observations(id TEXT PRIMARY KEY,block TEXT,endpoint TEXT,intent TEXT,span_seconds REAL,paired_late INTEGER,outcome TEXT);''')

def record_pairs(ledger,slots):
    rows=ledger.rows();by={}
    for r in rows:by.setdefault(r['slot'],[]).append(r)
    for i in range(0,len(slots),2):
        a,b=slots[i:i+2]
        if a['intent_id']!=b['intent_id'] or a['endpoint']!=b['endpoint'] or {a['language'],b['language']}!={'fi','en'}:raise RuntimeError('Frozen pair adjacency invalid')
        ar,br=by.get(a['slot_id'],[]),by.get(b['slot_id'],[])
        if not ar or not br:continue
        last=[ar[-1],br[-1]]
        if any(r['status']=='reserved' or r['end'] is None for r in last):continue
        starts=[float((ledger.db.execute('SELECT v FROM config WHERE k=?',('request_start:'+r['id'],)).fetchone() or [r['start']])[0]) for r in (ar[0],br[0])]
        span=max(r['end'] for r in last)-min(starts)
        outcome='complete' if all(r['status']=='complete' for r in last) else 'unusable'
        ledger.db.execute('INSERT OR REPLACE INTO paired_observations VALUES (?,?,?,?,?,?,?)',(block_id(a)+':'+a['endpoint']+':'+a['intent_id'],block_id(a),a['endpoint'],a['intent_id'],span,int(span>600),outcome))

def tick(root,m,now=None,execute=service.execute_one,backup_hook=None,key_loader=None,transport=None):
    """At most one paid attempt per tick. Caller owns timing, never replays a finished slot."""
    now=time.time() if now is None else now
    service.execution_gate(m,'primary')
    if m.get('schedule_enabled') is not True:raise RuntimeError('Scheduled collection disabled')
    grace=m.get('block_start_grace_seconds');duration=m.get('max_block_duration_seconds')
    if type(grace)!=int or grace<0 or type(duration)!=int or duration<=grace:raise RuntimeError('Explicit frozen block timing policy required')
    slots=schedule();groups={}
    for s in slots:groups.setdefault(block_id(s),[]).append(s)
    with service.singleflight(root):
        if hasattr(backup_hook,'verify_head'):backup_hook.verify_head(root)
        ledger=service.open_study(root,m['study_id'],m['verified_bounds']);changes_before=ledger.db.total_changes
        schema_before=ledger.db.execute('PRAGMA schema_version').fetchone()[0];schema(ledger)
        schema_changed=ledger.db.execute('PRAGMA schema_version').fetchone()[0]!=schema_before
        try:
            if ledger.db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone():return {'state':'halted','reason':'ledger_halted'}
            if ledger.db.execute('SELECT 1 FROM attempts WHERE actual IS NULL AND NOT EXISTS (SELECT 1 FROM accounting WHERE attempt_id=attempts.id)').fetchone():return {'state':'halted','reason':'unresolved_charge_or_request'}
            chosen=None
            for bid,block in groups.items():
                start=epoch(block[0]);r=ledger.db.execute('SELECT * FROM scheduled_blocks WHERE id=?',(bid,)).fetchone()
                if r and r['state'] in ('complete','missed','expired'):continue
                if now<start:return {'state':'waiting','wake_at':start,'block':bid}
                if not r and now>start+grace:
                    ledger.db.execute('INSERT INTO scheduled_blocks VALUES (?,?,?,?,?)',(bid,'missed',None,now,'start_window_missed_no_backfill'));continue
                if r and now>start+duration:
                    ledger.db.execute('UPDATE scheduled_blocks SET state=?,ended=?,reason=? WHERE id=?',('expired',now,'block_window_expired_no_backfill',bid));record_pairs(ledger,block);continue
                if not r:ledger.db.execute('INSERT INTO scheduled_blocks VALUES (?,?,?,?,?)',(bid,'active',now,None,None))
                chosen=(bid,block);break
            if chosen is None:return {'state':'finished','blocks':[dict(r) for r in ledger.db.execute('SELECT * FROM scheduled_blocks ORDER BY id')]}
            bid,block=chosen;by={}
            for r in ledger.rows():by.setdefault(r['slot'],[]).append(r)
            selected=None
            for slot in block:
                prior=by.get(slot['slot_id'],[])
                if not prior:selected=slot;break
                last=prior[-1]
                if last['status']=='retryable' and len(prior)==1:
                    retry_at=float((ledger.db.execute('SELECT v FROM config WHERE k=?',('retry_at:'+last['id'],)).fetchone() or [last['end']+60])[0])
                    if now<retry_at:return {'state':'waiting_retry','wake_at':retry_at,'block':bid}
                    selected=slot;break
                if last['status'] in ('fatal','unknown','reserved'):return {'state':'halted','reason':'unresolved_slot','block':bid}
                # Completed/incomplete and exhausted retry outcomes are retained, never rerun for content.
            if selected is None:
                record_pairs(ledger,block);ledger.db.execute('UPDATE scheduled_blocks SET state=?,ended=? WHERE id=?',('complete',now,bid))
                return {'state':'block_complete','block':bid}
            # Reservation happens inside execute_one after this read lock is released; its atomic unique claim protects races.
        finally:
            try:
                if schema_changed or ledger.db.total_changes>changes_before:
                    if backup_hook is None:raise RuntimeError('Scheduler state backup hook required')
                    service.backup(root,ledger,'scheduler-'+uuid.uuid4().hex,backup_hook)
            finally:ledger.db.close()
    try:
        result=execute(root,m,selected,'primary',transport=transport,backup_hook=backup_hook,key_loader=key_loader)
    except RuntimeError:
        return {'state':'halted','reason':'execution_or_budget_gate','block':bid}
    with service.singleflight(root):
        ledger=service.open_study(root,m['study_id'],m['verified_bounds'])
        try:
            record_pairs(ledger,block)
            if backup_hook is None:raise RuntimeError('Scheduler pair-state backup hook required')
            service.backup(root,ledger,'scheduler-pairs-'+uuid.uuid4().hex,backup_hook)
        finally:ledger.db.close()
    return {'state':'attempted','block':bid,'slot_id':selected['slot_id'],'result':result}

def run(root,m,backup_hook,key_loader=None,transport=None,clock=time.time,sleep=time.sleep):
    while True:
        result=tick(root,m,clock(),backup_hook=backup_hook,key_loader=key_loader,transport=transport)
        if result['state'] in ('halted','finished'):return result
        wait=max(0,min(60,result.get('wake_at',clock())-clock()))
        if wait:sleep(wait)
