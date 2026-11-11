import copy,json,pathlib,tempfile,time,unittest
import adapters,core,service,storage
BASE=pathlib.Path(__file__).parent
P=json.loads((BASE/'inputs/prompts.json').read_text());S=json.loads((BASE/'inputs/schedule_DRAFT.json').read_text())
T=2000000000

def iso(t):return core.datetime.datetime.fromtimestamp(t,core.datetime.timezone.utc).isoformat()
def cfg():
    endpoints={}
    for ep in sorted(core.ENDPOINTS):
        parameters={'max_output_tokens':100,'max_tool_calls':2,'tools':[{'type':'web_search'}]} if ep=='openai_api' else {'max_tokens':100}
        endpoints[ep]={'model':'fixture-'+ep,'allowed_models':['fixture-'+ep],'provider':'fixture','allowed_providers':['fixture'],'bound_verified':True,'bound_evidence':'SYNTHETIC TEST ONLY','qualified':False,'request_parameters':parameters,'timeout_seconds':300 if ep=='kimi_api' else 180,'reservation_micro_usd':1000000,'verified_max_output_tokens':100,'verified_max_total_input_tokens':100000,'verified_max_total_output_tokens':300,'verified_max_search_calls':2,'max_prompt_bytes':5000,'usage_cost_verified_all_in':True,'price':{'input_per_million':1,'output_per_million':2,'search_per_call':.01}}
    m={'study_id':core.STUDY,'market':'FI','language':'en','prompt_hash':core.digest(core.canonical(P)),'schedule_hash':core.digest(core.canonical(S)),'endpoints':endpoints,'approved_total_micro_usd':40000000,'provider_cap_micro_usd':30000000,'hosting_bound_micro_usd':5000000,'contingency_micro_usd':5000000,'hosting_bound_evidence':'SYNTHETIC','hosting_stop_evidence':'SYNTHETIC external stop','execution_expires_at_utc':iso(T+400000),'diagnostic_limit':9,'retry_limit':18,'qualification_enabled':True,'schedule_enabled':False,'rounds':[],'diagnostic_slots':[{'slot_id':core.STUDY+':diagnostic:'+ep+':ACC01','endpoint':ep,'prompt_id':'ACC01'} for ep in sorted(core.ENDPOINTS)]}
    for k in ('spend_approved','protocol_frozen','storage_verified','singleton_verified','hosting_bound_verified','paid_enabled','storage_setup_approved'):m[k]=True
    return freeze(m)
def freeze(m):m['manifest_sha256']=core.manifest_hash(m);return m
def response(ep):
    model='fixture-'+ep
    if ep=='openai_api':return {'model':model,'status':'completed','output':[{'type':'web_search_call','status':'completed'},{'type':'message','status':'completed','content':[{'type':'output_text','text':'Example response','annotations':[{'type':'url_citation','url':'https://example.com'}]}]}],'usage':{'input_tokens':100,'output_tokens':20}}
    if ep=='kimi_api':return {'model':model,'provider':'fixture','choices':[{'finish_reason':'stop','message':{'content':'Example response','annotations':[{'type':'url_citation','url_citation':{'url':'https://example.com'}}]}}],'usage':{'prompt_tokens':100,'completion_tokens':20,'cost':.01}}
    return {'model':model,'stop_reason':'end_turn','content':[{'type':'web_search_tool_result','content':[]},{'type':'text','text':'Example response','citations':[{'type':'web_search_result_location','url':'https://example.com'}]}],'usage':{'input_tokens':100,'output_tokens':20,'server_tool_use':{'web_search_requests':1}}}
class Fixture:
    def __init__(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/core.STUDY;self.m=cfg();self.objects={};self.calls=[];self.fail=False
        def transport(method,name,data):
            if method=='GET':return (200,self.objects[name]) if name in self.objects else (404,b'')
            if self.fail:raise RuntimeError('simulated backup failure')
            self.objects[name]=data;return 201,b''
        self.remote=storage.Remote('se.storage.bunnycdn.com','fixture','fixture-secret-not-real',core.STUDY,transport)
        service.init(self.root,self.m,P,S,self.remote)
    def execute(self,ep='openai_api',transport=None):
        slot=next(s for s in self.m['diagnostic_slots'] if s['endpoint']==ep)
        def fn(ep,body,key,timeout):self.calls.append((ep,body));return response(ep)
        return service.execute(self.root,self.m,P,S,slot,'diagnostic',self.remote,transport or fn,clock=lambda:T,key_loader=lambda _: 'fixture-key')
    def release(self):
        for ep in sorted(core.ENDPOINTS):self.execute(ep)
        new=copy.deepcopy(self.m);new.update(qualification_enabled=False,schedule_enabled=True,qualification_review_approved=True,rounds=[{'round':i,'start_utc':iso(T+(i-1)*86400),'end_utc':iso(T+(i-1)*86400+7200),'start_grace_seconds':600} for i in range(1,4)])
        for c in new['endpoints'].values():c['qualified']=True
        freeze(new);service.activate(self.root,new,P,S,self.remote,now=T);self.m=new

class Tests(unittest.TestCase):
    def setUp(self):self.f=Fixture()
    def tearDown(self):self.f.tmp.cleanup()
    def test_matrix(self):core.validate(self.f.m,P,S);self.assertEqual(len(S),180)
    def test_hash_guard(self):m=cfg();m['market']='GB';self.assertRaises(ValueError,core.validate,m,P,S)
    def test_total_guard(self):m=cfg();m['hosting_bound_micro_usd']=6000000;freeze(m);self.assertRaises(RuntimeError,core.validate,m,P,S,True,T,True)
    def test_hosting_guard(self):m=cfg();m['hosting_stop_evidence']='';freeze(m);self.assertRaises(RuntimeError,core.validate,m,P,S,True,T,True)
    def test_expiry(self):self.assertRaises(RuntimeError,core.validate,self.f.m,P,S,True,T+500000,True)
    def test_missing_bound(self):m=cfg();m['endpoints']['openai_api']['bound_verified']=False;freeze(m);self.assertRaises(RuntimeError,core.validate,m,P,S,True,T,True)
    def test_init_no_reset(self):self.assertRaises(RuntimeError,service.init,self.f.root,self.f.m,P,S,self.f.remote)
    def test_remote_head_mismatch(self):self.f.objects['latest-backup.json']=b'{}';self.assertRaises(RuntimeError,self.f.execute);self.assertEqual(self.f.calls,[])
    def test_local_state_guard(self):l=core.Ledger(self.f.root,self.f.m);l.halt('manual');l.close();self.assertRaises(RuntimeError,self.f.execute)
    def test_three_routes(self):
        for ep in sorted(core.ENDPOINTS):self.assertEqual(self.f.execute(ep)['status'],'complete')
    def test_no_replay(self):self.f.execute();self.assertRaises(RuntimeError,self.f.execute);self.assertEqual(len(self.f.calls),1)
    def test_unknown_timeout_holds_halts(self):
        def fail(*args):raise adapters.ProviderError('timeout')
        r=self.f.execute(transport=fail);self.assertTrue(r['charge_hold_retained']);l=core.Ledger(self.f.root,self.f.m);summary=l.summary();l.close();self.assertEqual(summary['unresolved'],1);self.assertTrue(summary['halted']);self.assertRaises(RuntimeError,self.f.execute)
    def test_backup_failure_before_provider(self):self.f.fail=True;self.assertRaises(RuntimeError,self.f.execute);self.assertEqual(self.f.calls,[])
    def test_model_mismatch_retains_charge(self):
        def bad(ep,*args):r=response(ep);r['model']='other';return r
        r=self.f.execute(transport=bad);self.assertEqual(r['status'],'fatal');self.assertIsNotNone(r['accounted_micro_usd'])
    def test_usage_unknown(self):
        def bad(ep,*args):r=response(ep);r.pop('usage');return r
        self.assertEqual(self.f.execute(transport=bad)['status'],'unknown')
    def test_incomplete_no_retry(self):
        def bad(ep,*args):r=response(ep);r['status']='incomplete';return r
        self.assertEqual(self.f.execute(transport=bad)['status'],'incomplete');self.assertRaises(RuntimeError,self.f.execute)
    def test_budget_reservation(self):
        l=core.Ledger(self.f.root,self.f.m)
        with self.assertRaises(RuntimeError):l.claim('test','openai_api','primary',31000000,self.f.m,T)
        self.assertEqual(len(l.rows()),0);l.close()
    def test_activation_requires_evidence(self):
        new=copy.deepcopy(self.f.m);new.update(schedule_enabled=True,qualification_enabled=False,qualification_review_approved=True,rounds=[{'round':i,'start_utc':iso(T+i*10000),'end_utc':iso(T+i*10000+1000),'start_grace_seconds':600} for i in range(1,4)])
        for c in new['endpoints'].values():c['qualified']=True
        freeze(new);self.assertRaises(RuntimeError,service.activate,self.f.root,new,P,S,self.f.remote,T)
    def test_activation_preserves_ledger(self):self.f.release();l=core.Ledger(self.f.root,self.f.m);self.assertEqual(l.summary()['attempts'],3);l.close();self.assertEqual(len(list((self.f.root/'manifests').glob('*.json'))),2)
    def test_new_price_forbidden(self):
        self.f.release();m=copy.deepcopy(self.f.m);m['endpoints']['openai_api']['price']['input_per_million']=99;freeze(m);self.assertRaises(RuntimeError,core.Ledger,self.f.root,m)
    def test_scheduler_wait_no_calls(self):self.f.release();r=service.tick(self.f.root,self.f.m,P,S,self.f.remote,now=T-1);self.assertEqual(r['state'],'waiting')
    def test_scheduler_missed_no_backfill(self):self.f.release();r=service.tick(self.f.root,self.f.m,P,S,self.f.remote,now=T+700);self.assertEqual(r['state'],'waiting');l=core.Ledger(self.f.root,self.f.m);self.assertEqual(l.db.execute('SELECT state FROM rounds WHERE id=1').fetchone()[0],'missed');l.close()
    def test_scheduler_one_attempt(self):
        self.f.release();seen=[]
        def capture(*args,**kwargs):seen.append(args[4]);return {'synthetic':True}
        r=service.tick(self.f.root,self.f.m,P,S,self.f.remote,now=T,execute_fn=capture);self.assertEqual(r['state'],'attempted');self.assertEqual(len(seen),1)
    def test_adapters_no_fallback(self):
        c=self.f.m['endpoints']['kimi_api'];b=[];adapters.request('kimi_api','test',c,'fixture',lambda ep,body,key,timeout:b.append(body) or response(ep));self.assertFalse(b[0]['provider']['allow_fallbacks'])
    def test_parse_claude_error(self):r=response('claude_api');r['content'][0]['content']={'type':'web_search_tool_result_error'};self.assertFalse(adapters.parse('claude_api',r,self.f.m['endpoints']['claude_api'])['complete'])
    def test_cost_basis(self):self.assertEqual(adapters.account('kimi_api',response('kimi_api'),self.f.m['endpoints']['kimi_api'])[1],'provider_reported_charge');self.assertEqual(adapters.account('openai_api',response('openai_api'),self.f.m['endpoints']['openai_api'])[1],'conservative_usage_upper_bound')
    def test_search_usage_guard(self):r=response('claude_api');r['usage']['server_tool_use']['web_search_requests']=3;self.assertRaises(ValueError,adapters.account,'claude_api',r,self.f.m['endpoints']['claude_api'])
    def test_safe_redaction(self):self.assertEqual(core.sanitize({'api_key':'secret','text':'Bearer abc'}),{'text':'[REDACTED]'})
    def test_delayed_backup_prevents_dispatch(self):
        calls=[];times=iter([T,T+500000,T+500000]);slot=self.f.m['diagnostic_slots'][0]
        r=service.execute(self.f.root,self.f.m,P,S,slot,'diagnostic',self.f.remote,transport=lambda *a:calls.append(a),clock=lambda:next(times),key_loader=lambda _: 'fixture')
        self.assertFalse(r['provider_request_sent']);self.assertEqual(calls,[]);self.assertEqual(r['accounted_micro_usd'],0)
    def test_location_echo_guard(self):
        c=copy.deepcopy(self.f.m['endpoints']['openai_api']);c.update(require_location_echo=True,requested_location={'country':'FI'})
        r=response('openai_api');self.assertRaises(RuntimeError,adapters.parse,'openai_api',r,c)
        r['tools']=[{'type':'web_search','user_location':{'country':'FI'}}]
        self.assertEqual(adapters.parse('openai_api',r,c)['effective_location_echo'],[{'country':'FI'}])
    def test_execution_order_guard(self):
        s=copy.deepcopy(S);s[0],s[1]=s[1],s[0];m=cfg();m['schedule_hash']=core.digest(core.canonical(s));freeze(m)
        self.assertRaises(ValueError,core.validate,m,P,s)
    def test_no_overwrite_old(self):self.assertRaises(RuntimeError,service.check_root,'/data/finland-language-v02')

if __name__=='__main__':unittest.main()
