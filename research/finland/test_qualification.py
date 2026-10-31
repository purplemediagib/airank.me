import json,pathlib,tempfile,unittest
from unittest.mock import patch
import qualification as q,service,storage,runner
class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/'study';service.initialize(self.root,'study');self.files={};self.calls=[]
        def http(method,url,data=None):
            if method=='PUT':self.files[url]=data;return 201,b''
            return (200,self.files[url]) if url in self.files else (404,b'')
        self.remote=storage.BunnyBackup('se.storage.bunnycdn.com','synthetic','FAKE','study',http)
        l=service.open_study(self.root,'study',{});service.backup(self.root,l,'initial-test',self.remote);l.db.close()
        self.m=json.loads(pathlib.Path('manifest_BOOTSTRAP_TEMPLATE.json').read_text());self.m['location_policy_version']='finland-v1';self.m['study_id']='study';self.m['singleton_deployment_confirmed']=True
        for k in ('secure_host_verified','durable_storage_verified','private_backup_verified'):self.m[k]=True
        self.m['providers']['kimi_candidate']['reviewed_request_parameters'].pop('max_tool_calls',None)
        self.m['providers']['kimi_candidate']['reviewed_request_parameters'].update(max_tokens=3000,stop_server_tools_when=[{'type':'step_count_is','step_count':1}])
        self.m['diagnostic_batch']={'checkpoint_review_approved':True,'checkpoint_review_reference':'SYNTHETIC CHECKPOINT REVIEW','supersedes_batch_id':'technical-v2','supersedes_reason':'synthetic reviewed truncation','enabled':True,'batch_id':q.BATCH_ID,'slots':q.frozen_slots(),'expected_models':{'kimi_candidate':['moonshotai/kimi-k3.1-pro'],'openai_responses':['gpt-4.1-mini-2025-04-14']}}
        self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
    def tearDown(self):self.tmp.cleanup()
    def response(self,url,body,key):
        self.calls.append(body['model'])
        annotation={'type':'url_citation','url':'https://example.invalid/source'}
        if 'openrouter' in url:return {'model':body['model'],'usage':{'cost':.01},'choices':[{'finish_reason':'stop','message':{'content':'SYNTHETIC','annotations':[annotation]}}]}
        return {'tools':body['tools'],'model':body['model'],'status':'completed','usage':{'input_tokens':100,'output_tokens':30},'output':[{'type':'web_search_call','status':'completed'},{'type':'message','content':[{'type':'output_text','text':'SYNTHETIC','annotations':[annotation]}]}]}
    def run_batch(self,transport=None):return q.run(self.root,self.m,self.remote,transport=transport or self.response,key_loader=lambda n:'SYNTHETIC')
    def test_full_batch_and_restart_no_duplicate(self):
        x=self.run_batch();self.assertEqual(len(self.calls),10);self.assertFalse(x['collection_qualified']);self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete');self.assertEqual(len(self.calls),10)
        report=json.loads(self.files[self.remote.base+x['report_file']]);self.assertEqual(report['budget']['diagnostic_attempts'],10);self.assertEqual(report['budget']['primary_slots'],0);self.assertFalse(report['collection_qualified']);self.remote.verify_head(self.root)
    def test_partial_resume(self):
        service.execute_one(self.root,self.m,q.frozen_slots()[0],'diagnostic',transport=self.response,backup_hook=self.remote,key_loader=lambda n:'SYNTHETIC')
        self.run_batch();self.assertEqual(len(self.calls),10)
    def test_unknown_cost_stops_and_no_replay(self):
        def unknown(*a):r=self.response(*a);r.pop('usage');return r
        self.assertEqual(self.run_batch(unknown)['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
        with self.assertRaisesRegex(RuntimeError,'Unresolved'):self.run_batch()
        self.assertEqual(len(self.calls),1)
    def test_missing_grounding_stops(self):
        def missing(*a):r=self.response(*a);r['output'][1]['content'][0]['annotations']=[];return r
        self.assertEqual(self.run_batch(missing)['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
    def test_drift_stops(self):
        def drift(*a):r=self.response(*a);r['model']='unexpected';return r
        self.assertEqual(self.run_batch(drift)['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
    def test_disabled_batch_no_calls(self):
        self.m['diagnostic_batch']['enabled']=False;self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaises(RuntimeError):self.run_batch()
        self.assertEqual(self.calls,[])
    def test_budget_exhaustion(self):
        def expensive(*a):r=self.response(*a);r['usage']['cost']=3.1;return r
        with self.assertRaisesRegex(RuntimeError,'Budget reservation refused'):self.run_batch(expensive)
        self.assertEqual(len(self.calls),3)
    def test_report_failure_blocks_before_call(self):
        with patch.object(self.remote,'put_verified',return_value={'verified':False}):
            with self.assertRaises(RuntimeError):self.run_batch()
        self.assertEqual(self.calls,[])
    def test_no_auto_primary_release(self):
        self.run_batch()
        with self.assertRaises(RuntimeError):service.execution_gate(self.m,'primary')
    def test_plan_exactly_twelve_existing_prompts(self):
        plan=q.frozen_slots();self.assertEqual(len(plan),10);self.assertEqual(len({s['slot_id'] for s in plan}),10)
        prompts,_=runner.load_inputs();ids={p['intent_id'] for p in prompts};self.assertTrue(all(s['intent_id'] in ids for s in plan))

    def test_missing_key_no_attempt_or_head_change(self):
        before=self.remote.head()
        with self.assertRaisesRegex(RuntimeError,'credentials absent'):
            q.run(self.root,self.m,self.remote,transport=self.response,key_loader=lambda n:None)
        self.assertEqual(self.calls,[]);self.assertEqual(self.remote.head(),before);self.remote.verify_head(self.root)
        l=service.open_study(self.root,'study',{});self.assertEqual(l.rows(),[]);l.db.close()
    def test_singleton_required(self):
        self.m['singleton_deployment_confirmed']=False;self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaisesRegex(RuntimeError,'Single replica'):self.run_batch()
        self.assertEqual(self.calls,[])

    def test_incomplete_preserves_counter_cost_and_finish_evidence(self):
        def truncated(*args):
            r=self.response(*args)
            if 'choices' not in r:return r
            r['choices'][0]['finish_reason']='length';r['choices'][0]['native_finish_reason']='max_output_tokens'
            r['usage']={'cost':0.0391368,'completion_tokens':1965,'cost_details':{'upstream_inference_cost':0.0251368},'server_tool_use_details':{'web_search_requests':5,'tool_calls_requested':5,'tool_calls_executed':5}}
            return r
        result=self.run_batch(truncated);report=json.loads(self.files[self.remote.base+result['report_file']]);x=report['attempts'][-1]
        self.assertEqual(x['stop_reason'],'output_truncated');self.assertEqual(x['reported_server_tool_counters']['web_search_requests'],5)
        self.assertEqual(x['exa_auto_fee_equivalent_searches'],'2.0000');self.assertFalse(x['reported_counters_are_verified_billable_searches']);self.assertIsNone(x['openai_search_output_item_count']);self.assertIn('raw_path',x)
    def test_seven_prior_rows_preserved_v3_ten_shared_budget(self):
        costs=[.0339956,.027496,.0391368]
        prior=[]
        for idx,(intent,lang) in enumerate([('ACC01','fi'),('ACC01','en'),('IT01','fi')]):
            slot={'slot_id':f'diagnostic:kimi_candidate:technical-v1-{intent}-{lang}','endpoint':'kimi_candidate','intent_id':intent,'language':lang}
            def response(url,body,key,idx=idx):
                r=self.response(url,body,key);r['usage']['cost']=costs[idx]
                r['usage']['server_tool_use_details']={'web_search_requests':[3,3,5][idx],'tool_calls_requested':[3,3,5][idx],'tool_calls_executed':[3,3,5][idx]}
                if idx==2:r['choices'][0]['finish_reason']='length'
                return r
            service.execute_one(self.root,self.m,slot,'diagnostic',transport=response,backup_hook=self.remote,key_loader=lambda n:'FAKE')
        for endpoint,lang,cost,inp,out in [('kimi_candidate','fi',.0359568,0,0),('kimi_candidate','en',.029176,0,0),('openai_responses','fi',None,8752,604),('openai_responses','en',None,8617,423)]:
            slot={'slot_id':f'diagnostic:{endpoint}:technical-v2-IT01-{lang}','endpoint':endpoint,'intent_id':'IT01','language':lang}
            def previous(url,body,key,cost=cost,inp=inp,out=out):
                r=self.response(url,body,key)
                if cost is not None:r['usage']['cost']=cost
                else:
                    r['usage']={'input_tokens':inp,'output_tokens':out};r['tools']=[{'type':'web_search','user_location':{'type':'approximate','country':'US'}}]
                return r
            service.execute_one(self.root,self.m,slot,'diagnostic',transport=previous,backup_hook=self.remote,key_loader=lambda n:'FAKE')
        l=service.open_study(self.root,'study',{});prior=l.rows();self.assertEqual(l.summary()['committed_or_held_micro_usd'],227154);l.db.close()
        self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete')
        l=service.open_study(self.root,'study',{});after=l.rows();summary=l.summary();l.db.close()
        self.assertEqual(after[:7],prior);self.assertEqual(summary['diagnostic_attempts'],17);self.assertEqual(summary['primary_slots'],0);self.assertLess(summary['committed_or_held_micro_usd'],38000000);self.assertEqual(summary['uncertain_charge_hold_micro_usd'],0)
        self.run_batch();self.assertEqual(len(self.calls),17)
    def test_serialized_v2_request(self):
        def capture(url,body,key):
            if 'openrouter' in url:
                self.assertNotIn('max_tool_calls',body);self.assertEqual(body['stop_server_tools_when'],[{'type':'step_count_is','step_count':1}]);self.assertEqual(body['max_tokens'],3000)
                self.assertEqual(body['tools'][0]['parameters']['max_uses'],2);self.assertFalse(body['provider']['allow_fallbacks'])
            return self.response(url,body,key)
        self.run_batch(capture)
    def test_v1_unknown_cannot_be_superseded(self):
        slot={'slot_id':'diagnostic:kimi_candidate:technical-v1-ACC01-fi','endpoint':'kimi_candidate','intent_id':'ACC01','language':'fi'}
        service.execute_one(self.root,self.m,slot,'diagnostic',transport=lambda *a:{'choices':[{'finish_reason':'stop','message':{'content':'synthetic'}}]},backup_hook=self.remote,key_loader=lambda n:'FAKE')
        with self.assertRaisesRegex(RuntimeError,'Unresolved'):self.run_batch()
        self.assertEqual(self.calls,[])
    def test_v2_reservation_cannot_be_lowered(self):
        self.m['verified_bounds']['kimi_candidate']['micro_usd']=7000000;self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaisesRegex(RuntimeError,'coarse'):self.run_batch()
        self.assertEqual(self.calls,[])

    def test_first_four_checkpoint_no_repeat_and_explicit_resume(self):
        self.m['diagnostic_batch']['checkpoint_review_approved']=False
        self.m['diagnostic_batch'].pop('checkpoint_review_reference',None);self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        self.assertEqual(self.run_batch()['status'],'qualification_checkpoint_review_required');self.assertEqual(len(self.calls),4)
        self.assertEqual(self.run_batch()['status'],'qualification_checkpoint_review_required');self.assertEqual(len(self.calls),4)
        self.m['diagnostic_batch']['checkpoint_review_approved']=True;self.m['diagnostic_batch']['checkpoint_review_reference']='SYNTHETIC FOUR SLOT REVIEW';self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete');self.assertEqual(len(self.calls),10)
    def test_checkpoint_approval_requires_reference(self):
        self.m['diagnostic_batch'].pop('checkpoint_review_reference');self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaisesRegex(RuntimeError,'Checkpoint review reference'):self.run_batch()
        self.assertEqual(self.calls,[])
    def test_actual_us_location_stops_before_next_call(self):
        def wrong(*a):
            r=self.response(*a);r['tools']=[{'type':'web_search','user_location':{'type':'approximate','country':'US'}}];return r
        x=self.run_batch(wrong);self.assertEqual(x['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
        report=json.loads(self.files[self.remote.base+x['report_file']]);self.assertEqual(report['attempts'][0]['stop_reason'],'search_location_missing_or_mismatched')
        self.assertIsNotNone(report['attempts'][0]['accounted']);self.assertEqual(report['attempts'][0]['attempt_manifest_sha256'],self.m['frozen_manifest_sha256'])
    def test_missing_effective_location_stops(self):
        def missing(*a):r=self.response(*a);r.pop('tools');return r
        self.assertEqual(self.run_batch(missing)['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
    def test_exact_new_openai_and_reused_unattempted_kimi_ids(self):
        plan=q.frozen_slots();self.assertEqual(len(plan),10)
        self.assertEqual(sum(x['endpoint']=='openai_responses' and ':technical-v3-' in x['slot_id'] for x in plan),6)
        self.assertEqual(sum(x['endpoint']=='kimi_candidate' and ':technical-v2-' in x['slot_id'] for x in plan),4)
        self.assertTrue(all(x['intent_id']!='IT01' for x in plan if x['endpoint']=='kimi_candidate'))
    def test_all_intents_have_symmetric_location_policy(self):
        prompts,_=runner.load_inputs();cities={'ACC04':'Tampere','IT04':'Turku','MKT04':'Helsinki'}
        for prompt in prompts:
            for lang in ('fi','en'):
                loc=service.requested_location('openai_responses',prompt['intent_id']);self.assertEqual(loc['country'],'FI');self.assertEqual(loc.get('city'),cities.get(prompt['intent_id']))
                self.assertIsNone(service.requested_location('kimi_candidate',prompt['intent_id']))
        self.assertFalse(service.location_matches({'tools':[{'type':'web_search','user_location':{'type':'approximate','country':'FI'}}]},service.requested_location('openai_responses','IT04')))
    def test_primary_bad_geo_known_cost_halts(self):
        for key in ('finnish_review_signed','protocol_frozen','models_qualified'):self.m[key]=True
        self.m['providers']['openai_responses']['qualified']=True;self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        _,slots=runner.load_inputs(endpoint='openai_responses');slot=next(s for s in slots if s['intent_id']=='IT04')
        def missing_city(*a):r=self.response(*a);r['tools']=[{'type':'web_search','user_location':{'type':'approximate','country':'FI'}}];return r
        result=service.execute_one(self.root,self.m,slot,'primary',transport=missing_city,backup_hook=self.remote,key_loader=lambda n:'FAKE');self.assertEqual(result['status'],'fatal')
        l=service.open_study(self.root,'study',{});row=l.rows()[0];self.assertIsNotNone(row['accounted']);self.assertIsNotNone(l.db.execute("select v from config where k='halt'").fetchone());l.db.close();self.remote.verify_head(self.root)

    def test_reused_reference_must_exist(self):
        self.m['diagnostic_batch']['reused_prior_qualification']=[{'attempt_id':'diagnostic:kimi_candidate:technical-v2-IT01-fi:a1','raw_sha256':'synthetic'}];self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaisesRegex(RuntimeError,'reference unavailable'):self.run_batch()
        self.assertEqual(self.calls,[])
