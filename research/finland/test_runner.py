import json, pathlib, tempfile, unittest
import runner as r
import adapters

class Tests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.path=pathlib.Path(self.t.name);self.l=r.Ledger(self.path/'ledger.db',ceiling=12_000_000,primary_limit=144)
    def tearDown(self):self.l.db.close();self.t.cleanup()
    def study(self,bound=1000000):
        specs={e:{'verified':True,'micro_usd':bound,'evidence':'SYNTHETIC TEST ONLY'} for e in ('openai_responses','kimi_candidate')}
        return r.StudyLedger(self.path/'study.db',specs,initialize=True)
    def test_shared_budget_both_providers(self):
        l=self.study(19_000_000)
        for e in ('openai_responses','kimi_candidate'):l.reserve_study(r.load_inputs(endpoint=e)[1][0]['slot_id'],e,now=0)
        with self.assertRaisesRegex(RuntimeError,'Budget'):l.reserve_study('diagnostic:openai_responses:1','openai_responses','diagnostic')
        self.assertEqual(l.summary()['approved_total_usd'],38);self.assertEqual(l.summary()['uncertain_charge_hold_micro_usd'],38_000_000)
    def test_unknown_bound_blocked(self):
        l=r.StudyLedger(self.path/'study.db',initialize=True)
        with self.assertRaisesRegex(RuntimeError,'verified'):l.reserve_study(r.load_inputs()[1][0]['slot_id'],'openai_responses')
        self.assertEqual(l.summary()['attempts'],0)
    def test_shared_diagnostics_max20(self):
        l=self.study(1000)
        for i in range(20):
            e=('openai_responses','kimi_candidate')[i%2];l.reserve_study(f'diagnostic:{e}:{i}',e,'diagnostic')
        with self.assertRaisesRegex(RuntimeError,'Diagnostic'):l.reserve_study('diagnostic:kimi_candidate:21','kimi_candidate','diagnostic')
    def test_study_requires_allowlist(self):
        l=self.study()
        with self.assertRaises(ValueError):l.reserve_study('arbitrary','openai_responses')
        with self.assertRaises(RuntimeError):l.reserve('arbitrary')
    def test_reconcile_releases_only_known_cost(self):
        l=self.study();a=l.reserve_study(r.load_inputs()[1][0]['slot_id'],'openai_responses',now=0);l.finish(a,'complete',{},actual=123,end=1)
        self.assertEqual(l.summary()['committed_or_held_micro_usd'],123);self.assertEqual(l.summary()['uncertain_charge_hold_micro_usd'],0)
    def test_openai_adapter_mock(self):
        seen=[]
        def mock(url,body,key):seen.append((url,body));return {'synthetic':True}
        cfg={'qualified':True,'all_billable_bound_verified':True,'model':r.MODEL,'max_tool_calls':2,'max_output_tokens':1500,'tool_choice':'required'}
        adapters.request_openai('synthetic',cfg,'FAKE_TEST_ONLY',mock)
        self.assertEqual(seen[0][1]['max_tool_calls'],2);self.assertFalse(seen[0][1]['store']);self.assertNotIn('previous_response_id',seen[0][1])
    def test_adapter_closed_without_bound(self):
        def forbidden(*a):raise AssertionError('Transport must never be called')
        with self.assertRaises(RuntimeError):adapters.request_openai('x',{'qualified':True},'fake',forbidden)
        with self.assertRaises(RuntimeError):adapters.request_kimi('x',{},'fake',forbidden)
    def test_kimi_adapter_pins_route(self):
        seen=[]
        cfg={'qualified':True,'all_billable_bound_verified':True,'route':'openrouter','model':'moonshotai/kimi-k3.1-pro-20261023','provider':'moonshotai/mxfp4','reviewed_request_parameters':{'max_tokens':1500}}
        adapters.request_kimi('synthetic',cfg,'FAKE',lambda url,body,key:seen.append(body))
        self.assertFalse(seen[0]['provider']['allow_fallbacks']);self.assertEqual(seen[0]['provider']['only'],['moonshotai/mxfp4'])
    def test_missing_live_ledger_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'Missing initialized'):r.StudyLedger(self.path/'missing.db')
    def test_incomplete_subtool_excluded(self):
        self.assertFalse(r.parse_response({'status':'completed','output':[{'type':'web_search_call','status':'incomplete'}]})['usable'])
    def test_retry_timestamp_not_end(self):
        a=self.l.reserve('s',now=0);self.l.finish(a,'retryable',{},error='429',end=5,retry_after=120)
        self.assertEqual(self.l.rows()[0]['end'],5)
    def test_redirect_refused(self):
        with self.assertRaises(adapters.ProviderError):adapters.NoRedirect().redirect_request()
    def test_matrix(self):
        p,s=r.load_inputs();self.assertEqual((len(p),len(s)),(12,144))
    def test_kimi_candidate_matrix(self):
        _,s=r.load_inputs(endpoint='kimi_candidate');self.assertEqual(len(s),144);self.assertTrue(all(x['endpoint']=='kimi_candidate' for x in s))
    def test_original_schedule_preserved(self):
        s=json.loads((r.ROOT/'inputs'/'proposed_schedule.json').read_text());self.assertEqual(sum(x['endpoint']=='gemini_openrouter' for x in s),144)
    def test_pair_balance(self):
        _,s=r.load_inputs();self.assertEqual(sum(x['language']=='fi' for x in s),72)
    def test_review_sample(self):
        p,s=r.load_inputs();self.assertEqual(len(set(r.review_sample(p,s))),36);self.assertEqual(r.review_sample(p,s),r.review_sample(p,s))
    def test_live_closed(self):
        with self.assertRaisesRegex(RuntimeError,'BLOCKED'):r.validate_live({})
    def test_live_adapter_absent(self):
        m={k:True for k in ('owner_spend_approval','diagnostic_approval','finnish_review','model_qualification','verified_billable_caps','protocol_freeze','execution_route_approval')};m.update(input_hashes=r.hashes(),model=r.MODEL)
        with self.assertRaisesRegex(RuntimeError,'deliberately not implemented'):r.validate_live(m)
    def test_duplicate(self):
        self.l.reserve('s')
        with self.assertRaises(RuntimeError):self.l.reserve('s')
    def test_budget(self):
        self.l.reserve('s',bound=12_000_000)
        with self.assertRaisesRegex(RuntimeError,'Budget'):self.l.reserve('t')
    def test_reservation_survives_restart(self):
        self.l.reserve('s',bound=12_000_000);other=r.Ledger(self.path/'ledger.db',ceiling=12_000_000,primary_limit=144)
        with self.assertRaises(RuntimeError):other.reserve('t')
        other.db.close()
    def test_retry(self):
        a=self.l.reserve('s',now=0);self.l.finish(a,'retryable',{},error='429',end=1)
        with self.assertRaises(RuntimeError):self.l.reserve('s',now=60)
        b=self.l.reserve('s',now=61);self.assertEqual(self.l.rows()[1]['parent'],a)
        self.l.finish(b,'retryable',{},error='5xx',end=62)
        with self.assertRaises(RuntimeError):self.l.reserve('s',now=122)
    def test_retry_after(self):
        a=self.l.reserve('s',now=0);self.l.finish(a,'retryable',{},error='429',end=1,retry_after=120)
        with self.assertRaises(RuntimeError):self.l.reserve('s',now=61)
        self.l.reserve('s',now=121)
    def test_refusal_no_retry(self):
        a=self.l.reserve('s',now=0);self.l.finish(a,'complete',{},actual=0,end=1)
        with self.assertRaises(RuntimeError):self.l.reserve('s',now=100)
    def test_nontransport_no_retry(self):
        a=self.l.reserve('s')
        with self.assertRaises(ValueError):self.l.finish(a,'retryable',{},error='no_citations')
    def test_diagnostic_cap(self):
        for n in range(20):self.l.reserve('d'+str(n),'diagnostic')
        with self.assertRaises(RuntimeError):self.l.reserve('d20','diagnostic')
    def test_diagnostic_no_retry(self):
        a=self.l.reserve('d','diagnostic',now=0);self.l.finish(a,'retryable',{},error='timeout',end=1)
        with self.assertRaises(RuntimeError):self.l.reserve('d','diagnostic',now=100)
    def test_primary_cap(self):
        for n in range(144):self.l.reserve(str(n))
        with self.assertRaises(RuntimeError):self.l.reserve('145')
    def test_actual_over_bound_halts(self):
        a=self.l.reserve('s');self.l.finish(a,'complete',{},actual=29201)
        with self.assertRaisesRegex(RuntimeError,'halted'):self.l.reserve('t')
    def test_unknown_halts(self):
        a=self.l.reserve('s');self.l.finish(a,'unknown',{})
        with self.assertRaises(RuntimeError):self.l.reserve('t')
    def test_fatal_halts(self):
        a=self.l.reserve('s');self.l.finish(a,'fatal',{},error='401')
        with self.assertRaises(RuntimeError):self.l.reserve('t')
    def test_cost_not_negative(self):
        a=self.l.reserve('s')
        with self.assertRaises(ValueError):self.l.finish(a,'complete',{},actual=-1)
    def test_finalize_once(self):
        a=self.l.reserve('s');self.l.finish(a,'complete',{})
        with self.assertRaises(RuntimeError):self.l.finish(a,'complete',{})
    def test_sanitize(self):
        x=r.sanitize({'authorization':'secret','input_tokens':12,'text':'Bearer abc sk-abcdef','url':'https://a.test/?token=abc'})
        self.assertNotIn('authorization',x);self.assertEqual(x['input_tokens'],12);self.assertNotIn('abc',x['text']);self.assertNotIn('token=abc',x['url'])
    def test_url(self):self.assertEqual(r.normalized_url('https://EXAMPLE.fi/a?id=3&utm_source=x#z'),'https://example.fi/a?id=3')
    def test_refusal_usable(self):
        x=r.parse_response({'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':'No recommendation'}]}]});self.assertTrue(x['usable']);self.assertTrue(x['refusal'])
    def test_missing_citations_not_no_search(self):
        x=r.parse_response({'status':'completed','output':[{'type':'web_search_call','status':'completed'}]});self.assertEqual(x['grounding_status'],'verified');self.assertEqual(x['citations'],[])
    def test_truncation(self):self.assertFalse(r.parse_response({'status':'incomplete'})['usable'])
    def test_empty_overlap(self):self.assertIsNone(r.overlap([],[]));self.assertEqual(r.overlap([],['a']),0);self.assertIsNone(r.overlap(None,['a']))
    def test_overlap_dedup(self):self.assertEqual(r.overlap(['a','a'],['a','b']),.5)
    def test_macro(self):
        rows=[{'intent_id':'a','fi':['x'],'en':['x']}]*6+[{'intent_id':'b','fi':['x'],'en':['y']}]
        self.assertEqual(r.analyze(rows)['macro_jaccard'],.5)
    def test_missing_late_empty(self):
        rows=[{'intent_id':'a','fi':None,'en':[]},{'intent_id':'a','fi':[],'en':[]},{'intent_id':'a','fi':['x'],'en':['x'],'span_seconds':601}]
        x=r.analyze(rows);self.assertIsNone(x['macro_jaccard']);self.assertEqual(x['coverage'],{'missing':1,'both_empty':1,'late':1})
    def test_full_dry_run(self):
        out=self.path/'synthetic';x=r.dry_run(out);self.assertEqual(x['synthetic_attempts'],144);self.assertEqual(x['paid_calls'],0)
        self.assertTrue((out/'SYNTHETIC_ONLY_NOT_RESEARCH_DATA').exists());self.assertEqual(len(list((out/'raw').iterdir())),144)
        with self.assertRaises(RuntimeError):r.dry_run(out)

if __name__=='__main__':unittest.main()
