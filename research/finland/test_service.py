import json,pathlib,tempfile,unittest
from unittest.mock import patch
import service,runner,adapters

class ServiceTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/'study'
    def tearDown(self):self.tmp.cleanup()
    def manifest(self):
        endpoint='kimi_candidate'
        m={k:True for k in ['owner_execution_approved','secure_host_verified','durable_storage_verified','private_backup_verified','all_billable_bounds_verified','diagnostics_approved']}
        m.update(study_id='test-study',provider_budget_usd=38,hosting_budget_usd=2,input_hashes=runner.hashes(),verified_bounds={endpoint:{'verified':True,'micro_usd':35_000_000,'evidence':'SYNTHETIC TEST'}},providers={endpoint:{'all_billable_bound_verified':True,'diagnostic_route_approved':True,'qualified':False,'usage_cost_verified_all_in':True,'route':'openrouter','model':'synthetic','provider':'synthetic','reviewed_request_parameters':{'max_tokens':1500}}})
        m['frozen_manifest_sha256']=service.manifest_hash(m)
        return m
    def slot(self,n=1):return {'slot_id':f'diagnostic:kimi_candidate:{n}','endpoint':'kimi_candidate','intent_id':'IT01','language':'fi'}
    def run_mock(self,response,n=1):return service.execute_one(self.root,self.manifest(),self.slot(n),'diagnostic',transport=lambda *a:response,backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'},key_loader=lambda n:'SYNTHETIC_KEY')
    def test_manifest_settings_tamper_blocked(self):
        m=self.manifest();m['providers']['kimi_candidate']['model']='changed'
        with self.assertRaisesRegex(RuntimeError,'manifest hash'):service.execution_gate(m,'diagnostic')
    def test_false_backup_ack_blocks(self):
        service.initialize(self.root,'test-study')
        with self.assertRaisesRegex(RuntimeError,'not verified'):service.execute_one(self.root,self.manifest(),self.slot(),'diagnostic',transport=lambda *a:self.fail('no network'),backup_hook=lambda p,h:None)
    def test_pending_tool_not_complete(self):
        service.initialize(self.root,'test-study');self.assertEqual(self.run_mock({'usage':{'cost':.01},'choices':[{'finish_reason':'tool_calls'}]})['status'],'incomplete')
    def test_backup_includes_raw(self):
        import tarfile
        service.initialize(self.root,'test-study');self.run_mock({'usage':{'cost':.01},'choices':[{'finish_reason':'stop'}]})
        with tarfile.open(next((self.root/'backups').glob('*finished.tar.gz'))) as t:self.assertTrue(any(n.startswith('raw/') and n.endswith('.json') for n in t.getnames()))
    def test_diagnostic_restart_same_action_never_replays(self):
        service.initialize(self.root,'test-study');self.run_mock({'usage':{'cost':0},'choices':[{'finish_reason':'stop'}]})
        with self.assertRaises(RuntimeError):self.run_mock({'usage':{'cost':0},'choices':[{'finish_reason':'stop'}]})
    def test_primary_model_drift_halts(self):
        service.initialize(self.root,'test-study');m=self.manifest()
        for k in ('finnish_review_signed','protocol_frozen','models_qualified'):m[k]=True
        m['providers']['kimi_candidate'].update(qualified=True,allowed_returned_models=['expected'])
        m['frozen_manifest_sha256']=service.manifest_hash(m)
        slot=runner.load_inputs(endpoint='kimi_candidate')[1][0]
        x=service.execute_one(self.root,m,slot,transport=lambda *a:{'model':'changed','usage':{'cost':.01},'choices':[{'finish_reason':'stop'}]},backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'},key_loader=lambda n:'fake')
        self.assertEqual(x['status'],'fatal')
    def test_init_once(self):
        service.initialize(self.root,'test-study')
        with self.assertRaises(RuntimeError):service.initialize(self.root,'test-study')
    def test_missing_identity(self):
        self.root.mkdir()
        with self.assertRaises(RuntimeError):service.open_study(self.root,'test-study',{})
    def test_wrong_identity(self):
        service.initialize(self.root,'test-study')
        with self.assertRaises(RuntimeError):service.open_study(self.root,'other',{})
    def test_singleflight(self):
        self.root.mkdir()
        with service.singleflight(self.root):
            with self.assertRaises(RuntimeError):
                with service.singleflight(self.root):pass
    def test_gates_closed(self):
        with self.assertRaisesRegex(RuntimeError,'gates closed'):service.execution_gate({},'diagnostic')
    def test_qualification_not_circular(self):
        service.initialize(self.root,'test-study');x=self.run_mock({'usage':{'cost':.02},'choices':[{'finish_reason':'stop','message':{'content':'synthetic'}}]});self.assertEqual(x['status'],'complete');self.assertEqual(len(list((self.root/'raw').iterdir())),1)
    def test_uncertain_cost_stops_next(self):
        service.initialize(self.root,'test-study');self.run_mock({'choices':[{'finish_reason':'stop'}]})
        with self.assertRaises(RuntimeError):self.run_mock({'usage':{'cost':.01}},2)
    def test_timeout_stops_next(self):
        service.initialize(self.root,'test-study')
        def fail(*a):raise adapters.ProviderError('timeout')
        service.execute_one(self.root,self.manifest(),self.slot(),'diagnostic',transport=fail,backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'},key_loader=lambda n:'fake')
        with self.assertRaises(RuntimeError):self.run_mock({'usage':{'cost':.01}},2)
    def test_no_backup_no_call(self):
        with self.assertRaisesRegex(RuntimeError,'backup hook'):service.execute_one(self.root,self.manifest(),self.slot(),'diagnostic')
    def test_collection_requires_review(self):
        with self.assertRaisesRegex(RuntimeError,'finnish_review'):service.execution_gate(self.manifest(),'primary')
    def test_backup_failure_prevents_request(self):
        service.initialize(self.root,'test-study')
        def fail(*a):raise RuntimeError('synthetic backup unavailable')
        with self.assertRaises(RuntimeError):service.execute_one(self.root,self.manifest(),self.slot(),'diagnostic',transport=lambda *a:self.fail('must not call'),backup_hook=fail,key_loader=lambda n:'fake')
    def test_private_raw_no_key(self):
        service.initialize(self.root,'test-study');self.run_mock({'usage':{'cost':0},'choices':[{'finish_reason':'stop'}]})
        self.assertNotIn('SYNTHETIC_KEY',next((self.root/'raw').iterdir()).read_text())

if __name__=='__main__':unittest.main()
