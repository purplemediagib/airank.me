import json,pathlib,tempfile,unittest
from unittest.mock import patch
import service,runner,adapters

class ServiceTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/'study'
    def tearDown(self):self.tmp.cleanup()
    def manifest(self):
        endpoint='kimi_candidate'
        m={k:True for k in ['owner_execution_approved','secure_host_verified','durable_storage_verified','private_backup_verified','all_billable_bounds_verified','diagnostics_approved']}
        m.update(location_policy_version='finland-v1',study_id='test-study',provider_budget_usd=38,hosting_budget_usd=2,input_hashes=runner.hashes(),verified_bounds={endpoint:{'verified':True,'micro_usd':35_000_000,'evidence':'SYNTHETIC TEST'}},providers={endpoint:{'all_billable_bound_verified':True,'diagnostic_route_approved':True,'qualified':False,'usage_cost_verified_all_in':True,'route':'openrouter','model':'synthetic','provider':'synthetic','reviewed_request_parameters':{'max_tokens':1500}}})
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
    def test_openai_accounted_upper_bound_allows_safe_next(self):
        service.initialize(self.root,'test-study');m=self.manifest()
        m['providers']['openai_responses']={'model':runner.MODEL,'qualified':False,'diagnostic_route_approved':True,'all_billable_bound_verified':True,'usage_upper_bound_accounting_verified':True,'max_tool_calls':2,'max_output_tokens':1500,'tool_choice':'required'}
        m['verified_bounds']['openai_responses']={'verified':True,'micro_usd':1000000,'evidence':'synthetic bound'};m['frozen_manifest_sha256']=service.manifest_hash(m)
        for i in range(2):
            slot={'slot_id':f'diagnostic:openai_responses:{i}','endpoint':'openai_responses','intent_id':'IT01','language':'fi'}
            x=service.execute_one(self.root,m,slot,'diagnostic',transport=lambda *a:{'model':runner.MODEL,'status':'completed','usage':{'input_tokens':1000,'output_tokens':1500}},backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'},key_loader=lambda n:'fake')
            self.assertEqual(x['status'],'complete');self.assertIsNone(x['provider_actual_cost_micro_usd']);self.assertEqual(x['conservative_accounted_micro_usd'],29200)
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

class HealthBindTests(unittest.TestCase):
    def test_default_loopback(self):
        from unittest.mock import patch
        with patch.dict(service.os.environ,{},clear=True):self.assertEqual(service.health_bind(),'127.0.0.1')
    def test_explicit_internal_probe_bind(self):
        from unittest.mock import patch
        with patch.dict(service.os.environ,{'RESEARCH_HEALTH_BIND':'0.0.0.0'},clear=True):self.assertEqual(service.health_bind(),'0.0.0.0')
    def test_other_bind_rejected(self):
        from unittest.mock import patch
        for value in ('example.com','::','127.0.0.2',''):
            with patch.dict(service.os.environ,{'RESEARCH_HEALTH_BIND':value},clear=True):
                with self.assertRaises(RuntimeError):service.health_bind()

class SafeFailureTests(unittest.TestCase):
    def test_no_secrets_or_exception_text(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import storage
        with patch.dict(service.os.environ,{'RESEARCH_STORAGE_ACCESS_KEY':'TOP-SECRET-NEVER-LOG','RESEARCH_MANIFEST_JSON':'{'},clear=True):
            x=service.safe_failure(storage.StorageError('TOP-SECRET-EXCEPTION',403,'GET'),SimpleNamespace(study_id='study'))
        text=json.dumps(x)
        self.assertNotIn('TOP-SECRET',text);self.assertEqual(x['storage_http_status'],403)
        self.assertTrue(x['environment_present']['RESEARCH_STORAGE_ACCESS_KEY'])
        self.assertNotIn('secret_length',text);self.assertFalse(x['manifest_hash_matches'])
    def test_manifest_checks_only_booleans(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        m={'study_id':'study','storage_access_approved':True};m['frozen_manifest_sha256']=service.manifest_hash(m)
        with patch.dict(service.os.environ,{'RESEARCH_MANIFEST_JSON':json.dumps(m)},clear=True):
            x=service.safe_failure(RuntimeError('private'),SimpleNamespace(study_id='study'))
        self.assertTrue(x['manifest_hash_matches']);self.assertTrue(x['study_id_matches']);self.assertTrue(x['study_id_valid'])
    def test_permission_code(self):
        from types import SimpleNamespace
        x=service.safe_failure(PermissionError('private path'),SimpleNamespace(study_id='study'))
        self.assertEqual(x['failure_code'],'filesystem_permission_denied')

class PreflightTests(unittest.TestCase):
    def test_read_only_no_directory_creation(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import storage
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'absent';calls=[]
            def fake(method,url,data=None):
                calls.append(method);return 404,b''
            b=storage.BunnyBackup('se.storage.bunnycdn.com','fake-zone','FAKE','study',fake)
            m={'study_id':'study','storage_access_approved':True};m['frozen_manifest_sha256']=service.manifest_hash(m)
            args=SimpleNamespace(manifest=None,mode='preflight',study_id='study',data_dir=str(root))
            with patch.dict(service.os.environ,{'RESEARCH_MANIFEST_JSON':json.dumps(m)},clear=True),patch.object(storage,'from_env',return_value=b):x=service.perform(args)
            self.assertEqual(calls,['GET']);self.assertFalse(root.exists());self.assertEqual(x['storage_writes'],0);self.assertEqual(x['status'],'preflight_passed')

class DiagnosticPreflightTests(unittest.TestCase):
    def probe(self,mismatch=False,fail=False):
        from unittest.mock import patch
        import storage,qualification,hashlib,sqlite3
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'study'
            service.initialize(root,'study')
            (root/'qualification.lock').touch()
            with sqlite3.connect(root/'ledger.sqlite') as db:
                fingerprint=hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()
            head={'sequence':1,'ledger_fingerprint':fingerprint}
            (root/'remote-head.json').write_text(json.dumps(head))
            remotehead={**head,'sequence':2} if mismatch else head
            calls=[]
            def transport(method,url,data=None):
                calls.append(method)
                self.assertEqual(method,'GET')
                if fail:raise storage.StorageError('SECRET BODY',503,'GET')
                if url.endswith('study-marker.json'):return 200,json.dumps({'study_id':'study','provider_cap_micro_usd':38000000}).encode()
                if url.endswith('latest-backup.json'):return 200,json.dumps(remotehead).encode()
                return 404,b''
            remote=storage.BunnyBackup('se.storage.bunnycdn.com','synthetic','FAKE','study',transport)
            def snapshot():return {str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            before=snapshot()
            def report(copy,m,sink):
                self.assertNotEqual(pathlib.Path(copy),root)
                sink.put_verified('qualification-synthetic.json',b'{}')
                return {'budget':{'diagnostic_attempts':0,'committed_or_held_micro_usd':0,'uncertain_charge_hold_micro_usd':0},'attempts':[]},'qualification-synthetic.json'
            with patch.object(qualification,'report',side_effect=report),patch.object(service,'execute_one',side_effect=AssertionError('no paid calls')),patch.object(service,'backup',side_effect=AssertionError('no backup')):
                if fail:
                    with self.assertRaises(storage.StorageError):service.diagnostic_preflight(root,{'study_id':'study'},remote)
                    result=None
                else:result=service.diagnostic_preflight(root,{'study_id':'study'},remote)
            self.assertEqual(before,snapshot())
            self.assertTrue(all(x=='GET' for x in calls))
            return result
    def test_readonly_diagnostic_probe(self):
        x=self.probe()
        self.assertTrue(x['remote_local_head_equal']);self.assertTrue(x['ledger_matches_remote_head'])
        self.assertEqual(x['paid_calls'],0);self.assertEqual(x['storage_writes'],0)
        self.assertFalse(x['report_present'])
    def test_probe_head_mismatch_is_reported_not_repaired(self):
        x=self.probe(mismatch=True)
        self.assertFalse(x['remote_local_head_equal']);self.assertEqual(x['remote_head_sequence'],2)
    def test_probe_network_failure_never_dispatches(self):self.probe(fail=True)
    def test_missing_local_head_fixed_stage(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            (root/'runner.lock').touch();(root/'qualification.lock').touch()
            remote=SimpleNamespace(read_marker=lambda:None,head=lambda:{})
            with self.assertRaises(FileNotFoundError) as caught:
                service.diagnostic_preflight(root,{'study_id':'study'},remote)
            x=service.safe_failure(caught.exception,SimpleNamespace(study_id='study'))
            self.assertEqual(x['failure_stage'],'probe_local_head_read')
            self.assertEqual(x['failure_code'],'required_file_missing')

class RecoveryRouteTests(unittest.TestCase):
    def test_recovery_action_never_dispatches_or_initializes(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import storage
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            for name in ('runner.lock','qualification.lock'):(root/name).touch()
            m={'study_id':'study','storage_access_approved':True,'singleton_deployment_confirmed':True}
            m['frozen_manifest_sha256']=service.manifest_hash(m)
            args=SimpleNamespace(mode='checkpoint_reconcile',manifest=None,study_id='study',data_dir=str(root))
            with patch.dict(service.os.environ,{'RESEARCH_MANIFEST_JSON':json.dumps(m)},clear=True),patch.object(storage,'from_env',return_value=object()),patch.object(storage,'reconcile_checkpoint',return_value={'paid_calls':0}) as repair,patch.object(service,'execute_one',side_effect=AssertionError('no paid dispatch')),patch.object(service,'initialize',side_effect=AssertionError('no initialize')):
                self.assertEqual(service.perform(args),{'paid_calls':0})
                repair.assert_called_once()
    def test_filesystem_error_code_no_private_message(self):
        from types import SimpleNamespace
        x=service.safe_failure(OSError(28,'PRIVATE PATH'),SimpleNamespace(study_id='study'))
        self.assertEqual(x['filesystem_errno'],28)
        self.assertNotIn('PRIVATE',json.dumps(x))
