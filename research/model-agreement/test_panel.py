import json,pathlib,collections,unittest
import core
class PanelTests(unittest.TestCase):
    def test_approved_fresh_panel(self):
        r=pathlib.Path(__file__).parent;p=json.loads((r/'inputs/prompts.json').read_text());s=json.loads((r/'inputs/schedule_DRAFT.json').read_text());m=json.loads((r/'manifest_DRAFT.json').read_text())
        core.validate(m,p,s)
        self.assertEqual(sorted(collections.Counter(x['sector'] for x in p).values()),[4]*5)
        self.assertEqual({x['prompt_id'][:3] for x in p},{'HOT','GYM','CLN','COW','PAR'})
        self.assertTrue(all(x['review_status']=='user_approved_2026-11-11' for x in p))
        self.assertEqual([x['start_utc'] for x in m['rounds']],['2026-11-12T01:00:00Z','2026-11-14T01:00:00Z','2026-11-18T01:00:00Z'])
        for slot in s:self.assertEqual(slot['scheduled_at_utc'],m['rounds'][slot['round']-1]['start_utc'])
        self.assertTrue(all(not m[k] for k in ['paid_enabled','schedule_enabled','qualification_enabled']))
        self.assertEqual(sum(m[k] for k in ['provider_cap_micro_usd','hosting_bound_micro_usd','contingency_micro_usd']),40000000)
if __name__=='__main__':unittest.main()

class AdapterBoundTests(unittest.TestCase):
    def test_claude_search_limit(self):
        import adapters
        from test_runner import cfg
        c=cfg()['endpoints']['claude_api'];c['request_parameters']['tools'][0]['max_uses']=3
        with self.assertRaises(RuntimeError):adapters.request('claude_api','x',c,'fixture',lambda *_:self.fail())
    def test_kimi_exa_limit(self):
        import adapters
        from test_runner import cfg
        c=cfg()['endpoints']['kimi_api'];c['request_parameters']['plugins'][0]['engine']='native'
        with self.assertRaises(RuntimeError):adapters.request('kimi_api','x',c,'fixture',lambda *_:self.fail())
    def test_claude_cache_aggregate(self):
        import adapters
        from test_runner import cfg,response
        c=cfg()['endpoints']['claude_api'];r=response('claude_api');r['usage']['cache_read_input_tokens']=100000;c['price']['cache_read_per_million']=.1
        with self.assertRaises(ValueError):adapters.account('claude_api',r,c)
    def test_reservation_derivation(self):
        import adapters
        from test_runner import cfg
        c=cfg()['endpoints']['openai_api'];c['reservation_micro_usd']=1
        with self.assertRaises(RuntimeError):adapters.reservation_bound(c)
    def test_unreviewed_units(self):
        import adapters
        from test_runner import cfg
        c=cfg()['endpoints']['openai_api'];c['billing_units_reviewed']=False
        with self.assertRaises(RuntimeError):adapters.reservation_bound(c)

class StorageSetupTests(unittest.TestCase):
    def test_storage_budget_exceeded_no_payload(self):
        from test_runner import Fixture
        f=Fixture()
        try:
            b=json.loads(f.objects['storage-budget.json']);b['committed_bytes']=1000000000;f.objects['storage-budget.json']=core.canonical(b)
            with self.assertRaises(RuntimeError):f.remote.put_verified('new.json',b'{}')
            self.assertNotIn('new.json',f.objects)
        finally:f.tmp.cleanup()
    def test_init_nonempty_zone(self):
        from test_runner import Fixture,P,S
        import setup_driver
        f=Fixture()
        try:
            f.m['paid_enabled']=False;f.m['qualification_enabled']=False
            with self.assertRaises(RuntimeError):setup_driver.initialize(f.root,f.m,P,S,f.remote,lambda _:False)
        finally:f.tmp.cleanup()
    def test_two_evidence_reservations(self):
        import adapters
        m=json.loads((pathlib.Path(__file__).parent/'manifest_DRAFT.json').read_text())
        self.assertEqual(adapters.reservation_bound(m['endpoints']['claude_api']),6470000)
        self.assertEqual(adapters.reservation_bound(m['endpoints']['kimi_api']),164973)
