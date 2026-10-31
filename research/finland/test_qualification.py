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
        self.m=json.loads(pathlib.Path('manifest_BOOTSTRAP_TEMPLATE.json').read_text());self.m['study_id']='study';self.m['singleton_deployment_confirmed']=True
        for k in ('secure_host_verified','durable_storage_verified','private_backup_verified'):self.m[k]=True
        self.m['providers']['kimi_candidate']['reviewed_request_parameters'].pop('max_tool_calls',None)
        self.m['providers']['kimi_candidate']['reviewed_request_parameters'].update(max_tokens=3000,stop_server_tools_when=[{'type':'step_count_is','step_count':1}])
        self.m['diagnostic_batch']={'checkpoint_review_approved':True,'checkpoint_review_reference':'SYNTHETIC CHECKPOINT REVIEW','supersedes_batch_id':'technical-v1','supersedes_reason':'synthetic reviewed truncation','enabled':True,'batch_id':q.BATCH_ID,'slots':q.frozen_slots(),'expected_models':{'kimi_candidate':['moonshotai/kimi-k3.1-pro'],'openai_responses':['gpt-4.1-mini-2025-04-14']}}
        self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
    def tearDown(self):self.tmp.cleanup()
    def response(self,url,body,key):
        self.calls.append(body['model'])
        annotation={'type':'url_citation','url':'https://example.invalid/source'}
        if 'openrouter' in url:return {'model':body['model'],'usage':{'cost':.01},'choices':[{'finish_reason':'stop','message':{'content':'SYNTHETIC','annotations':[annotation]}}]}
        return {'model':body['model'],'status':'completed','usage':{'input_tokens':100,'output_tokens':30},'output':[{'type':'web_search_call','status':'completed'},{'type':'message','content':[{'type':'output_text','text':'SYNTHETIC','annotations':[annotation]}]}]}
    def run_batch(self,transport=None):return q.run(self.root,self.m,self.remote,transport=transport or self.response,key_loader=lambda n:'SYNTHETIC')
    def test_full_batch_and_restart_no_duplicate(self):
        x=self.run_batch();self.assertEqual(len(self.calls),12);self.assertFalse(x['collection_qualified']);self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete');self.assertEqual(len(self.calls),12)
        report=json.loads(self.files[self.remote.base+x['report_file']]);self.assertEqual(report['budget']['diagnostic_attempts'],12);self.assertEqual(report['budget']['primary_slots'],0);self.assertFalse(report['collection_qualified']);self.remote.verify_head(self.root)
    def test_partial_resume(self):
        service.execute_one(self.root,self.m,q.frozen_slots()[0],'diagnostic',transport=self.response,backup_hook=self.remote,key_loader=lambda n:'SYNTHETIC')
        self.run_batch();self.assertEqual(len(self.calls),12)
    def test_unknown_cost_stops_and_no_replay(self):
        def unknown(*a):r=self.response(*a);r.pop('usage');return r
        self.assertEqual(self.run_batch(unknown)['status'],'qualification_review_required');self.assertEqual(len(self.calls),1)
        with self.assertRaisesRegex(RuntimeError,'Unresolved'):self.run_batch()
        self.assertEqual(len(self.calls),1)
    def test_missing_grounding_stops(self):
        def missing(*a):r=self.response(*a);r['choices'][0]['message']['annotations']=[];return r
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
        self.assertEqual(len(self.calls),1)
    def test_report_failure_blocks_before_call(self):
        with patch.object(self.remote,'put_verified',return_value={'verified':False}):
            with self.assertRaises(RuntimeError):self.run_batch()
        self.assertEqual(self.calls,[])
    def test_no_auto_primary_release(self):
        self.run_batch()
        with self.assertRaises(RuntimeError):service.execution_gate(self.m,'primary')
    def test_plan_exactly_twelve_existing_prompts(self):
        plan=q.frozen_slots();self.assertEqual(len(plan),12);self.assertEqual(len({s['slot_id'] for s in plan}),12)
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
            r=self.response(*args);r['choices'][0]['finish_reason']='length';r['choices'][0]['native_finish_reason']='max_output_tokens'
            r['usage']={'cost':0.0391368,'completion_tokens':1965,'cost_details':{'upstream_inference_cost':0.0251368},'server_tool_use_details':{'web_search_requests':5,'tool_calls_requested':5,'tool_calls_executed':5}}
            return r
        result=self.run_batch(truncated);report=json.loads(self.files[self.remote.base+result['report_file']]);x=report['attempts'][0]
        self.assertEqual(x['stop_reason'],'output_truncated');self.assertEqual(x['reported_server_tool_counters']['web_search_requests'],5)
        self.assertEqual(x['exa_auto_fee_equivalent_searches'],'2.0000');self.assertFalse(x['reported_counters_are_verified_billable_searches']);self.assertIsNone(x['openai_search_output_item_count']);self.assertIn('raw_path',x)
    def test_v1_three_rows_preserved_v2_twelve_shared_budget(self):
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
        l=service.open_study(self.root,'study',{});prior=l.rows();self.assertEqual(sum(r['actual'] for r in prior),100629);l.db.close()
        self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete')
        l=service.open_study(self.root,'study',{});after=l.rows();summary=l.summary();l.db.close()
        self.assertEqual(after[:3],prior);self.assertEqual(summary['diagnostic_attempts'],15);self.assertEqual(summary['primary_slots'],0);self.assertLess(summary['committed_or_held_micro_usd'],38000000);self.assertEqual(summary['uncertain_charge_hold_micro_usd'],0)
        self.run_batch();self.assertEqual(len(self.calls),15)
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
        self.assertEqual(self.run_batch()['status'],'diagnostic_batch_complete');self.assertEqual(len(self.calls),12)
    def test_checkpoint_approval_requires_reference(self):
        self.m['diagnostic_batch'].pop('checkpoint_review_reference');self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
        with self.assertRaisesRegex(RuntimeError,'Checkpoint review reference'):self.run_batch()
        self.assertEqual(self.calls,[])
