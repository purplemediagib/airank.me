import copy,json,unittest
import core,service,storage
from test_runner import Fixture,P,S,T,iso,freeze
class AmendmentTests(unittest.TestCase):
    def setUp(self):
        self.f=Fixture()
        # Reinitialize a synthetic fixture only before any work for original eight-dollar cap.
        self.f.tmp.cleanup();self.f=Fixture();self.old=self.f.m
        # Fixture default no endpoint cap; construct original cap without changing live data by fresh test setup.
        self.old['endpoints']['claude_api']['local_lifetime_cap_micro_usd']=8000000;freeze(self.old)
        import pathlib,tempfile
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/core.STUDY;self.f.objects.clear();service.init(self.root,self.old,P,S,self.f.remote)
        for ep in core.ENDPOINTS:
            slot=next(s for s in self.old['diagnostic_slots'] if s['endpoint']==ep)
            from test_runner import response
            service.execute(self.root,self.old,P,S,slot,'diagnostic',self.f.remote,lambda ep,*_:response(ep),clock=lambda:T,key_loader=lambda _:'fixture')
        self.new=copy.deepcopy(self.old);self.new.update(qualification_enabled=False,schedule_enabled=True,qualification_review_approved=True,rounds=[{'round':i,'start_utc':iso(T+(i-1)*86400),'end_utc':iso(T+(i-1)*86400+7200),'start_grace_seconds':600} for i in (1,2,3)])
        for c in self.new['endpoints'].values():c['qualified']=True
        self.new['endpoints']['claude_api']['local_lifetime_cap_micro_usd']=15000000;freeze(self.new)
    def tearDown(self):self.tmp.cleanup();self.f.tmp.cleanup()
    def test_authorized_preserves(self):
        result=service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True)
        self.assertEqual(result['prior_attempts_retained'],3);self.f.remote.verify(self.root,self.new)
        l=core.Ledger(self.root,self.new);self.assertEqual(l.summary()['attempts'],3);l.close()
        self.assertTrue((self.root/'raw/claude-cap-amendment.json').exists());self.assertTrue((self.root/'manifests'/(self.old['manifest_sha256']+'.json')).exists())
    def test_explicit_guard_required(self):
        with self.assertRaises(RuntimeError):service.activate(self.root,self.new,P,S,self.f.remote,now=T)
    def test_no_other_change(self):
        self.new['provider_cap_micro_usd']-=1;freeze(self.new)
        with self.assertRaises(RuntimeError):service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True)
    def test_no_primary_work(self):
        l=core.Ledger(self.root,self.old);l.db.execute("INSERT INTO attempts(id,slot,endpoint,kind,n,status,reserved,accounted,start) VALUES ('x','x','openai_api','primary',1,'complete',1,1,?)",(T,));storage.backup(self.root,l,self.f.remote,self.old);l.close()
        with self.assertRaises(RuntimeError):service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True)

class ReceiptAmendmentTests(AmendmentTests):
    def setUp(self):
        super().setUp()
        l=core.Ledger(self.root,self.old);r=l.db.execute("SELECT * FROM attempts WHERE endpoint='openai_api'").fetchone();self.aid=r['id'];path=self.root/r['raw_path'];raw=json.loads(path.read_text());raw['response']['usage'].update(input_tokens=8804,output_tokens=637,input_tokens_details={'cached_tokens':0});path.write_bytes(core.canonical(raw));self.sha=core.digest(path.read_bytes())
        l.db.execute("UPDATE attempts SET status='unknown',accounted=NULL,reserved=10000000,raw_hash=? WHERE id=?",(self.sha,self.aid));l.halt('uncertain_or_excess_charge_or_fatal');storage.backup(self.root,l,self.f.remote,self.old);l.close()
        self.new['endpoints']['openai_api']['accounting_mode']='expected_search_estimate';freeze(self.new)
        from unittest.mock import patch
        self.patch=patch.object(service,'OA_RECONCILE_RAW_SHA',self.sha);self.patch.start()
    def tearDown(self):self.patch.stop();super().tearDown()
    def test_authorized_preserves(self):
        service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True,oa_reconciliation=True)
        l=core.Ledger(self.root,self.new);r=l.db.execute('SELECT * FROM attempts WHERE id=?',(self.aid,)).fetchone();self.assertEqual(r['accounted'],19470);self.assertEqual(r['status'],'complete');self.assertFalse(l.summary()['halted']);self.assertEqual(l.summary()['attempts'],3);l.close();self.f.remote.verify(self.root,self.new)
        self.assertTrue((self.root/'raw/approved-oa-qualifier-reconciliation.json').exists())
    def test_wrongraw(self):
        from unittest.mock import patch
        with patch.object(service,'OA_RECONCILE_RAW_SHA','0'*64):
            with self.assertRaises(RuntimeError):service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True,oa_reconciliation=True)
    def test_unrelatedhalt(self):
        l=core.Ledger(self.root,self.old);l.halt('other_reason');storage.backup(self.root,l,self.f.remote,self.old);l.close()
        with self.assertRaises(RuntimeError):service.activate(self.root,self.new,P,S,self.f.remote,now=T,claude_reallocation=True,oa_reconciliation=True)
    def test_estimate_not_bound(self):
        import adapters
        from test_panel import OperationalGuardTests
        c=OperationalGuardTests().config();c['accounting_mode']='expected_search_estimate'
        from test_runner import response
        value,basis=adapters.account('openai_api',response('openai_api'),c);self.assertIn('NOT_UPPER_BOUND',basis)
