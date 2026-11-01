import pathlib,tempfile,unittest,json
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
          'kimi_candidate':{'qualified':True,'all_billable_bound_verified':True,'allowed_returned_models':['synthetic'],'allowed_returned_providers':['synthetic'],'bound_evidence':{'endpoint_context_tokens':1048576,'max_model_passes':3},'route':'openrouter','model':'synthetic','provider':'synthetic','reviewed_request_parameters':{'max_tokens':1500},'usage_cost_verified_all_in':True},
          'openai_responses':{'qualified':True,'all_billable_bound_verified':True,'allowed_returned_models':[runner.MODEL],'model':runner.MODEL,'max_tool_calls':2,'max_output_tokens':1500,'tool_choice':'required','usage_upper_bound_accounting_verified':True}}
        for b in self.m['verified_bounds'].values():b['micro_usd']=1000000
        self.freeze()
        def model(url,*a):
            if 'openai.com' in url:return {'tools':a[0]['tools'],'model':runner.MODEL,'status':'completed','usage':{'input_tokens':100,'output_tokens':100}}
            return {'model':'synthetic','provider':'synthetic','usage':{'cost':.01,'prompt_tokens':100,'completion_tokens':100},'choices':[{'finish_reason':'stop'}]}
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
        self.tick();self.now+=7201;self.assertEqual(self.tick()['state'],'attempted');self.assertEqual(len(self.calls),2)
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


    def test_operational_seven_dollar_admission_keeps_prior_costs_all_blocks(self):
        self.m['verified_bounds']['kimi_candidate']['micro_usd']=7000000
        self.m['verified_bounds']['openai_responses']['micro_usd']=1500000
        self.freeze()
        l=service.open_study(self.root,'scheduled-test',self.m['verified_bounds'])
        for i in range(17):
            a=l.reserve_study(f'diagnostic:openai_responses:synthetic-prior-{i}','openai_responses','diagnostic')
            l.finish(a,'complete',{},actual=30000)
        l.db.close()
        def execute(root,m,slot,kind,**kwargs):
            ledger=service.open_study(root,m['study_id'],m['verified_bounds'])
            aid=ledger.reserve_study(slot['slot_id'],slot['endpoint'],kind,now=self.now)
            ledger.finish(aid,'complete',{},actual=30000,end=self.now+1);ledger.db.close()
            return {'status':'complete'}
        for start in sorted({scheduler.epoch(s) for s in scheduler.schedule()}):
            self.now=start
            for _ in range(49):
                result=scheduler.tick(self.root,self.m,self.now,execute=execute,backup_hook=lambda p,h:{'verified':True,'sha256':h,'reference':'synthetic://backup'})
                self.assertNotEqual(result['state'],'halted')
        l=service.open_study(self.root,'scheduled-test',self.m['verified_bounds'])
        summary=l.summary();l.db.close()
        self.assertEqual(summary['attempts'],305);self.assertEqual(summary['diagnostic_attempts'],17)
        self.assertEqual(summary['primary_slots'],288);self.assertEqual(summary['committed_or_held_micro_usd'],9150000)
class EveningScheduleTests(unittest.TestCase):
    def test_explicit_evening_six_blocks_and_original_preserved(self):
        import collections
        rows=scheduler.schedule()
        self.assertEqual(collections.Counter((x['proposed_date_utc'],x['proposed_block_utc']) for x in rows),{(date,hour):48 for date in ('2026-11-01','2026-11-03','2026-11-07') for hour in ('21:00','23:00')})
        self.assertEqual(len({x['slot_id'] for x in rows}),288)
        old=json.loads((runner.ROOT/'inputs/schedule_v02_openai_kimi_DRAFT.json').read_text())
        self.assertEqual({x['proposed_block_utc'] for x in old},{'08:00','14:00'})
        self.assertEqual({x['supersedes_v02_slot_id'] for x in rows},{x['slot_id'] for x in old})

class NovemberReleaseTests(unittest.TestCase):
    def test_helsinki_dates_and_spacing(self):
        import datetime,zoneinfo
        starts=sorted({scheduler.epoch(s) for s in scheduler.schedule()})
        self.assertEqual([int(starts[i+1]-starts[i]) for i in range(5)],[7200,165600,7200,338400,7200])
        self.assertEqual([datetime.datetime.fromtimestamp(x,zoneinfo.ZoneInfo('Europe/Helsinki')).isoformat() for x in starts],[f'2026-11-{d}T{t}:00+02:00' for d,t in [('01','23:00'),('02','01:00'),('03','23:00'),('04','01:00'),('07','23:00'),('08','01:00')]])
    def test_original_order_and_pairs_preserved(self):
        old=json.loads((runner.ROOT/'inputs/schedule_v02_openai_kimi_DRAFT.json').read_text())
        new=scheduler.schedule()
        fields=['endpoint','intent_id','language','intent_order','language_order']
        self.assertEqual([[x[k] for k in fields] for x in new],[[x[k] for k in fields] for x in old])
        for a,b in zip(new[::2],new[1::2]):
            self.assertEqual((a['endpoint'],a['intent_id']),(b['endpoint'],b['intent_id']))
            self.assertEqual({a['language'],b['language']},{'fi','en'})
