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
        self.m['diagnostic_batch']={'enabled':True,'batch_id':q.BATCH_ID,'slots':q.frozen_slots(),'expected_models':{'kimi_candidate':['moonshotai/kimi-k3.1-pro'],'openai_responses':['gpt-4.1-mini-2025-04-14']}}
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
        self.run_batch();self.assertEqual(len(self.calls),1)
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
