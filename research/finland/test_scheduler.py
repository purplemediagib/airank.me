import pathlib,tempfile,unittest
import runner,service,scheduler,storage
class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/'study';service.initialize(self.root,'scheduled-test');self.now=scheduler.epoch(scheduler.schedule()[0]);self.calls=[]
        self.m={k:True for k in ['owner_execution_approved','secure_host_verified','durable_storage_verified','private_backup_verified','all_billable_bounds_verified','finnish_review_signed','protocol_frozen','models_qualified','schedule_enabled']}
        self.m['location_policy_version']='finland-v1'
        self.m.update(study_id='scheduled-test',provider_budget_usd=38,hosting_budget_usd=2,input_hashes=runner.hashes(),block_start_grace_seconds=600,max_block_duration_seconds=7200,verified_bounds={e:{'verified':True,'micro_usd':1000,'evidence':'synthetic'} for e in ('openai_responses','kimi_candidate')})
        self.freeze()
    def tearDown(self):self.tmp.cleanup()
    def freeze(self):self.m['frozen_manifest_sha256']=service.manifest_hash(self.m)
    def execute(self,root,m,slot,kind,**kw):
        self.calls.append(slot['slot_id']);l=service.open_study(root,m['study_id'],m['verified_bounds']);a=l.reserve_study(slot['slot_id'],slot['endpoint'],kind,now=self.now);l.finish(a,'complete',{},actual=1,end=self.now+1);l.db.close();return {'status':'complete'}
    def tick(self):return scheduler.tick(self.root,self.m,self.now,execute=self.execute,backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'})
    def test_real_storage_hook_scheduler_integration(self):
        files={}
        def http(method,url,data=None):
            if method=='PUT':files[url]=data;return 201,b''
            return (200,files[url]) if url in files else (404,b'')
        hook=storage.BunnyBackup('storage.bunnycdn.com','fake-zone','FAKE','scheduled-test',http)
        l=service.open_study(self.root,'scheduled-test',{});service.backup(self.root,l,'initial-test',hook);l.db.close()
        self.m['providers']={
          'kimi_candidate':{'qualified':True,'all_billable_bound_verified':True,'allowed_returned_models':['synthetic'],'route':'openrouter','model':'synthetic','provider':'synthetic','reviewed_request_parameters':{'max_tokens':1500},'usage_cost_verified_all_in':True},
          'openai_responses':{'qualified':True,'all_billable_bound_verified':True,'allowed_returned_models':[runner.MODEL],'model':runner.MODEL,'max_tool_calls':2,'max_output_tokens':1500,'tool_choice':'required','usage_upper_bound_accounting_verified':True}}
        for b in self.m['verified_bounds'].values():b['micro_usd']=1000000
        self.freeze()
        def model(url,*a):
            if 'openai.com' in url:return {'tools':a[0]['tools'],'model':runner.MODEL,'status':'completed','usage':{'input_tokens':100,'output_tokens':100}}
            return {'model':'synthetic','usage':{'cost':.01},'choices':[{'finish_reason':'stop'}]}
        r=scheduler.tick(self.root,self.m,self.now-1,backup_hook=hook,key_loader=lambda n:'FAKE',transport=model);self.assertEqual(r['state'],'waiting');hook.verify_head(self.root)
        for _ in range(4):
            r=scheduler.tick(self.root,self.m,self.now,backup_hook=hook,key_loader=lambda n:'FAKE',transport=model);self.assertEqual(r['state'],'attempted');hook.verify_head(self.root)
        # Local financial rollback must be rejected BEFORE scheduler can checkpoint over remote evidence.
        l=service.open_study(self.root,'scheduled-test',{});l.db.execute('DELETE FROM attempts');l.db.close()
        with self.assertRaises(storage.StorageError):scheduler.tick(self.root,self.m,self.now,backup_hook=hook,key_loader=lambda n:'FAKE',transport=model)
    def test_all_six_blocks_288_distinct_slots(self):
        starts=sorted({scheduler.epoch(s) for s in scheduler.schedule()})
        for start in starts:
            self.now=start
            for _ in range(48):self.assertEqual(self.tick()['state'],'attempted')
            self.assertEqual(self.tick()['state'],'block_complete')
        self.assertEqual(self.tick()['state'],'finished');self.assertEqual(len(set(self.calls)),288)
        l=service.open_study(self.root,'scheduled-test',{});self.assertEqual(l.db.execute('SELECT COUNT(*) FROM paired_observations').fetchone()[0],144);l.db.close()
    def test_gate_false_no_calls(self):
        self.m['schedule_enabled']=False;self.freeze()
        with self.assertRaises(RuntimeError):self.tick()
        self.assertEqual(self.calls,[])
    def test_future_wait_no_call(self):
        self.now-=1;self.assertEqual(self.tick()['state'],'waiting');self.assertEqual(self.calls,[])
    def test_adjacent_pair_and_resume(self):
        self.tick();self.tick();self.assertEqual(self.calls,scheduler.schedule()[0:2] and [s['slot_id'] for s in scheduler.schedule()[:2]])
        self.tick();self.assertEqual(len(set(self.calls)),3)
    def test_missed_block_no_backfill(self):
        self.now+=601;r=self.tick();self.assertEqual(r['state'],'waiting');self.assertEqual(self.calls,[])
        l=service.open_study(self.root,'scheduled-test',{});self.assertEqual(l.db.execute('SELECT state FROM scheduled_blocks').fetchone()[0],'missed');l.db.close()
    def test_expired_active_block(self):
        self.tick();self.now+=7201;self.assertEqual(self.tick()['state'],'waiting');self.assertEqual(len(self.calls),1)
    def test_block_completes48(self):
        for _ in range(48):self.assertEqual(self.tick()['state'],'attempted')
        self.assertEqual(self.tick()['state'],'block_complete');self.assertEqual(len(set(self.calls)),48)
    def test_late_pair_flag(self):
        self.tick();self.now+=601;self.tick();l=service.open_study(self.root,'scheduled-test',{});r=l.db.execute('SELECT paired_late,span_seconds FROM paired_observations').fetchone();self.assertEqual(r[0],1);self.assertGreater(r[1],600);l.db.close()
    def test_unknown_hold_stops(self):
        slot=scheduler.schedule()[0];l=service.open_study(self.root,'scheduled-test',self.m['verified_bounds']);a=l.reserve_study(slot['slot_id'],slot['endpoint'],now=self.now);l.finish(a,'retryable',{},error='timeout',end=self.now+1);l.db.close();self.assertEqual(self.tick()['state'],'halted');self.assertEqual(self.calls,[])
    def test_budget_exhaustion_halts(self):
        for b in self.m['verified_bounds'].values():b['micro_usd']=38_000_000
        self.freeze();self.tick();self.assertEqual(self.tick()['state'],'halted');self.assertEqual(len(self.calls),2)
    def test_retry_after_reconciliation_once(self):
        slot=scheduler.schedule()[0];l=service.open_study(self.root,'scheduled-test',self.m['verified_bounds']);a=l.reserve_study(slot['slot_id'],slot['endpoint'],now=self.now);l.finish(a,'retryable',{},actual=0,error='429',end=self.now+1);l.db.close()
        self.assertEqual(self.tick()['state'],'waiting_retry');self.now+=61;self.tick();self.tick();self.assertEqual(self.calls,[slot['slot_id'],scheduler.schedule()[1]['slot_id']])
    def test_all_missed_finished(self):
        self.now=scheduler.epoch(scheduler.schedule()[-1])+10000;self.assertEqual(self.tick()['state'],'finished');self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
