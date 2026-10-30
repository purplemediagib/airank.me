"""Explicit, bounded technical qualification batch; never marks collection qualified."""
import hashlib,json,pathlib,os
import runner,service
BATCH_ID='technical-v1'
def frozen_slots():
    return [{'slot_id':f'diagnostic:{e}:{BATCH_ID}-{i}-{lang}','endpoint':e,'intent_id':i,'language':lang}
            for e in ('kimi_candidate','openai_responses') for i in ('ACC01','IT01','MKT01') for lang in ('fi','en')]

def evidence(root,row,expected):
    result={k:row[k] for k in ('id','slot','status','reserved','actual','accounted','accounting_basis','start','end')}
    result['review_required']=True
    if row['status']!='complete' or (row['actual'] is None and row['accounted'] is None):
        result['stop_reason']='attempt_not_complete_or_cost_unknown';return result
    meta=json.loads(row['raw']);path=pathlib.Path(root)/meta['raw_path']
    if runner.digest(path.read_bytes())!=meta['raw_hash']:raise RuntimeError('Qualification raw checksum differs')
    raw=json.loads(path.read_text())['response'];model=raw.get('model')
    result.update(returned_model=model,raw_path=meta['raw_path'],raw_sha256=meta['raw_hash'],usage=raw.get('usage'),returned_provider=raw.get('provider'))
    annotations=[]
    for item in raw.get('output',[]):
        for block in item.get('content',[]):annotations+=block.get('annotations',[])
    for choice in raw.get('choices',[]):annotations+=choice.get('message',{}).get('annotations',[])
    citations=[a for a in annotations if isinstance(a,dict) and a.get('type')=='url_citation']
    result['citation_annotation_count']=len(citations)
    result['search_telemetry_count']=sum(x.get('type')=='web_search_call' for x in raw.get('output',[]))
    result['grounding_execution_verified']=False  # Citation presence alone cannot establish execution semantics.
    if model not in expected:result['stop_reason']='returned_model_requires_review'
    elif not citations:result['stop_reason']='grounding_evidence_missing_or_unrecognized'
    return result

def report(root,m,remote):
    ledger=service.open_study(root,m['study_id'],m['verified_bounds'])
    try:
        rows=ledger.rows();summary=ledger.summary()
    finally:ledger.db.close()
    plan=frozen_slots();by={s['slot_id']:s for s in plan};items=[]
    for row in rows:
        if row['slot'] in by:
            endpoint=by[row['slot']]['endpoint'];items.append(evidence(root,row,m['diagnostic_batch']['expected_models'][endpoint]))
    data={'study_id':m['study_id'],'batch_id':BATCH_ID,'manifest_sha256':m['frozen_manifest_sha256'],'diagnostic_only':True,'collection_qualified':False,'human_review_required':True,'planned_slots':12,'attempts':items,'budget':summary}
    payload=json.dumps(runner.sanitize(data),sort_keys=True,ensure_ascii=False).encode();digest=runner.digest(payload)
    name=f'qualification-{BATCH_ID}-{len(items):02d}-{digest[:16]}.json'
    ack=remote.put_verified(name,payload)
    if ack.get('verified') is not True or ack.get('sha256')!=digest:raise RuntimeError('Qualification report backup not verified')
    return data,name

def run(root,m,remote,execute=service.execute_one,transport=None,key_loader=None):
    service.execution_gate(m,'diagnostic')
    if m.get('singleton_deployment_confirmed') is not True:raise RuntimeError('Single replica deployment not confirmed')
    config=m.get('diagnostic_batch',{})
    if config.get('enabled') is not True or config.get('batch_id')!=BATCH_ID or config.get('slots')!=frozen_slots():raise RuntimeError('Frozen diagnostic batch not explicitly enabled')
    if set(config.get('expected_models',{}))!={'kimi_candidate','openai_responses'} or any(not v for v in config['expected_models'].values()):raise RuntimeError('Diagnostic model allowlists absent')
    loader=key_loader or (lambda name:os.environ.get(name))
    if not all(bool(loader(name)) for name in ('OPENAI_API_KEY','OPENROUTER_API_KEY')):raise RuntimeError('Required provider credentials absent; no reservation made')
    # Batch lock is separate from execute_one financial lock; no second batch can run concurrently.
    import fcntl
    with (pathlib.Path(root)/'qualification.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        for slot in frozen_slots():
            service.execution_gate(m,'diagnostic');remote.verify_head(root)
            data,name=report(root,m,remote)
            if any(x.get('stop_reason') for x in data['attempts']):return {'status':'qualification_review_required','report_file':name,'collection_qualified':False}
            if any(x['slot']==slot['slot_id'] for x in data['attempts']):continue
            execute(root,m,slot,'diagnostic',transport=transport,backup_hook=remote,key_loader=key_loader)
            data,name=report(root,m,remote)
            if any(x.get('stop_reason') for x in data['attempts']):return {'status':'qualification_review_required','report_file':name,'collection_qualified':False}
        return {'status':'diagnostic_batch_complete','report_file':name,'collection_qualified':False,'human_review_required':True}
