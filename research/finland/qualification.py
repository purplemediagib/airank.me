"""Explicit, bounded technical qualification batch; never marks collection qualified."""
import hashlib,json,pathlib,os
import runner,service
BATCH_ID='technical-v3'
def frozen_slots():
    # New OpenAI FI-located IDs; retain only the unattempted Kimi v2 slots.
    pairs=[('openai_responses','IT01'),('kimi_candidate','ACC01'),('kimi_candidate','MKT01'),('openai_responses','ACC01'),('openai_responses','MKT01')]
    return [{'slot_id':f"diagnostic:{e}:{'technical-v2' if e=='kimi_candidate' else BATCH_ID}-{i}-{lang}",'endpoint':e,'intent_id':i,'language':lang} for e,i in pairs for lang in ('fi','en')]

def evidence(root,row,expected):
    result={k:row[k] for k in ('id','slot','status','reserved','actual','accounted','accounting_basis','start','end')}
    result['review_required']=True
    meta=json.loads(row['raw']) if row.get('raw') else {}
    raw={};wrapper={}
    if meta.get('raw_path') and meta.get('raw_hash'):
        path=pathlib.Path(root)/meta['raw_path']
        if runner.digest(path.read_bytes())!=meta['raw_hash']:raise RuntimeError('Qualification raw checksum differs')
        wrapper=json.loads(path.read_text());raw=wrapper['response']
        result['attempt_manifest_sha256']=wrapper.get('manifest_sha256')
        result['location_policy_version']=wrapper.get('location_policy_version')
        result['requested_search_location']=wrapper.get('requested_search_location')
        result.update(returned_model=raw.get('model'),raw_path=meta['raw_path'],raw_sha256=meta['raw_hash'],usage=raw.get('usage'),returned_provider=raw.get('provider'))
    choices=raw.get('choices',[])
    result['finish_reasons']=[c.get('finish_reason') for c in choices]
    result['native_finish_reasons']=[c.get('native_finish_reason') for c in choices]
    usage=raw.get('usage') or {};detail=usage.get('server_tool_use_details') or {}
    result['reported_server_tool_counters']={k:detail[k] for k in ('tool_calls_requested','tool_calls_executed','web_search_requests') if type(detail.get(k)) is int and detail[k]>=0}
    result['reported_counters_are_verified_billable_searches']=False
    # Accounting difference is evidence, not proof of how many requests executed.
    from decimal import Decimal,InvalidOperation
    try:
        cost=Decimal(str(usage['cost']));inference=Decimal(str(usage['cost_details']['upstream_inference_cost']))
        delta=cost-inference
        if cost.is_finite() and inference.is_finite() and delta>=0:
            result['non_inference_charge_usd']=str(delta)
            result['exa_auto_fee_equivalent_searches']=str(delta/Decimal('0.007'))
            result['fee_equivalence_is_inference_not_execution_count']=True
    except (KeyError,TypeError,InvalidOperation):pass
    annotations=[]
    for item in raw.get('output',[]):
        for block in item.get('content',[]):annotations+=block.get('annotations',[])
    for choice in choices:annotations+=choice.get('message',{}).get('annotations',[])
    citations=[a for a in annotations if isinstance(a,dict) and a.get('type')=='url_citation']
    result['citation_annotation_count']=len(citations)
    result['openai_search_output_item_count']=sum(x.get('type')=='web_search_call' for x in raw.get('output',[])) if 'output' in raw else None
    result['grounding_execution_verified']=False
    expected_location=service.requested_location(wrapper.get('slot',{}).get('endpoint'),wrapper.get('slot',{}).get('intent_id'))
    result['effective_location_matches']=service.location_matches(raw,expected_location) if expected_location else None
    result['returned_search_locations']=[x.get('user_location') for x in raw.get('tools',[]) if isinstance(x,dict) and x.get('type')=='web_search']
    if row['actual'] is None and row['accounted'] is None:result['stop_reason']='cost_unknown'
    elif row['status']!='complete':
        result['stop_reason']='output_truncated' if 'length' in result['finish_reasons'] or 'max_output_tokens' in result['native_finish_reasons'] else 'attempt_not_complete'
    elif raw.get('model') not in expected:result['stop_reason']='returned_model_requires_review'
    elif expected_location and (wrapper.get('location_policy_version')!=service.LOCATION_POLICY_VERSION or not result['effective_location_matches']):result['stop_reason']='search_location_missing_or_mismatched'
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
    data={'study_id':m['study_id'],'batch_id':BATCH_ID,'manifest_sha256':m['frozen_manifest_sha256'],'diagnostic_only':True,'supersedes_batch_id':'technical-v2','supersedes_for':'qualification_only; previous attempts and charges retained','collection_qualified':False,'human_review_required':True,'planned_slots':len(plan),'reused_prior_qualification':m['diagnostic_batch'].get('reused_prior_qualification',[]),'attempts':items,'budget':summary}
    payload=json.dumps(runner.sanitize(data),sort_keys=True,ensure_ascii=False).encode();digest=runner.digest(payload)
    name=f'qualification-{BATCH_ID}-{len(items):02d}-{digest[:16]}.json'
    ack=remote.put_verified(name,payload)
    if ack.get('verified') is not True or ack.get('sha256')!=digest:raise RuntimeError('Qualification report backup not verified')
    return data,name

def run(root,m,remote,execute=service.execute_one,transport=None,key_loader=None):
    service.execution_gate(m,'diagnostic')
    if m.get('singleton_deployment_confirmed') is not True:raise RuntimeError('Single replica deployment not confirmed')
    if m.get('location_policy_version')!=service.LOCATION_POLICY_VERSION:raise RuntimeError('V3 Finland location policy required')
    config=m.get('diagnostic_batch',{})
    if config.get('enabled') is not True or config.get('batch_id')!=BATCH_ID or config.get('slots')!=frozen_slots():raise RuntimeError('Frozen diagnostic batch not explicitly enabled')
    if set(config.get('expected_models',{}))!={'kimi_candidate','openai_responses'} or any(not v for v in config['expected_models'].values()):raise RuntimeError('Diagnostic model allowlists absent')
    loader=key_loader or (lambda name:os.environ.get(name))
    if not all(bool(loader(name)) for name in ('OPENAI_API_KEY','OPENROUTER_API_KEY')):raise RuntimeError('Required provider credentials absent; no reservation made')
    if config.get('supersedes_batch_id')!='technical-v2' or not config.get('supersedes_reason'):raise RuntimeError('Explicit prior qualification supersession required')
    params=m['providers']['kimi_candidate']['reviewed_request_parameters']
    if params.get('stop_server_tools_when')!=[{'type':'step_count_is','step_count':1}] or 'max_tool_calls' in params or params.get('max_tokens')!=3000:raise RuntimeError('V2 request bounds differ from reviewed candidate')
    if m['verified_bounds']['kimi_candidate']['micro_usd']!=35000000:raise RuntimeError('V2 requires unchanged coarse qualification reservation')
    if config.get('checkpoint_review_approved') is True and not config.get('checkpoint_review_reference'):raise RuntimeError('Checkpoint review reference required')
    # Batch lock is separate from execute_one financial lock; no second batch can run concurrently.
    import fcntl
    with (pathlib.Path(root)/'qualification.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        remote.verify_head(root)
        ledger=service.open_study(root,m['study_id'],m['verified_bounds'])
        try:
            prior=ledger.rows()
            if any(x['status']=='reserved' or (x['actual'] is None and x['accounted'] is None) for x in prior):raise RuntimeError('Unresolved prior request; supersession cannot bypass hold')
            if ledger.db.execute("SELECT 1 FROM config WHERE k='halt'").fetchone():raise RuntimeError('Ledger halted; manual reconciliation required')
            by_id={x['id']:x for x in prior}
            for ref in config.get('reused_prior_qualification',[]):
                row=by_id.get(ref.get('attempt_id'))
                if not row or not row['id'].startswith('diagnostic:kimi_candidate:technical-v2-IT01-') or row['status']!='complete':raise RuntimeError('Prior qualification reference unavailable or incomplete')
                meta=json.loads(row['raw'])
                if meta.get('raw_hash')!=ref.get('raw_sha256'):raise RuntimeError('Prior qualification reference checksum mismatch')
                if evidence(root,row,config['expected_models']['kimi_candidate']).get('stop_reason'):raise RuntimeError('Prior qualification evidence not reusable')
        finally:ledger.db.close()
        for slot in frozen_slots():
            service.execution_gate(m,'diagnostic');remote.verify_head(root)
            data,name=report(root,m,remote)
            if any(x.get('stop_reason') for x in data['attempts']):return {'status':'qualification_review_required','report_file':name,'collection_qualified':False}
            if len(data['attempts'])>=4 and config.get('checkpoint_review_approved') is not True:return {'status':'qualification_checkpoint_review_required','report_file':name,'collection_qualified':False,'completed_checkpoint_slots':4}
            if any(x['slot']==slot['slot_id'] for x in data['attempts']):continue
            execute(root,m,slot,'diagnostic',transport=transport,backup_hook=remote,key_loader=key_loader)
            data,name=report(root,m,remote)
            if any(x.get('stop_reason') for x in data['attempts']):return {'status':'qualification_review_required','report_file':name,'collection_qualified':False}
        return {'status':'diagnostic_batch_complete','report_file':name,'collection_qualified':False,'human_review_required':True}
