import copy,json,pathlib,tempfile,unittest
import core,service,storage,cloud_driver
from test_runner import Fixture,P,S,T
class CloudTests(unittest.TestCase):
    def setUp(self):self.f=Fixture();self.anchor=core.digest(core.canonical(self.f.remote.head()))
    def tearDown(self):self.f.tmp.cleanup()
    def test_chain_at_anchor(self):self.assertEqual(cloud_driver.verify_chain(self.f.remote,self.anchor),self.f.remote.head())
    def test_descendants(self):
        self.f.execute();self.assertEqual(cloud_driver.verify_chain(self.f.remote,self.anchor),self.f.remote.head())
    def test_untrusted_anchor(self):
        with self.assertRaises(RuntimeError):cloud_driver.verify_chain(self.f.remote,'0'*64)
    def test_broken_ancestor(self):
        self.f.execute();head=self.f.remote.head();self.f.objects['head-'+head['previous_head_sha256']+'.json']=b'bad'
        with self.assertRaises(RuntimeError):cloud_driver.verify_chain(self.f.remote,self.anchor)
    def test_reject_unknown_charges(self):
        l=core.Ledger(self.f.root,self.f.m);l.halt('unknown');l.close()
        with self.assertRaises(RuntimeError):cloud_driver.safe_ledger(self.f.root,self.f.m)
    def test_receipt_hash(self):
        self.f.execute();l=core.Ledger(self.f.root,self.f.m);p=l.rows()[0]['raw_path'];l.close();(self.f.root/p).write_bytes(b'bad')
        with self.assertRaises(RuntimeError):cloud_driver.safe_ledger(self.f.root,self.f.m)
    def test_prior_round_required(self):
        with self.assertRaises(RuntimeError):cloud_driver.safe_ledger(self.f.root,self.f.m,2)
    def test_no_round_replay(self):
        l=core.Ledger(self.f.root,self.f.m);l.db.execute("INSERT INTO rounds VALUES (1,'active',1,NULL,NULL)");l.close()
        with self.assertRaises(RuntimeError):cloud_driver.safe_ledger(self.f.root,self.f.m,1)
class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.f=Fixture();self.f.tmp.cleanup();self.f=Fixture();self.f.objects.clear();self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)/core.STUDY
        self.old=json.loads((cloud_driver.ROOT/'manifest_PRE_10AM.json').read_text());self.new=json.loads((cloud_driver.ROOT/'manifest_RELEASE.json').read_text())
        self.prompts=json.loads((cloud_driver.ROOT/'inputs/prompts.json').read_text());self.slots=json.loads((cloud_driver.ROOT/'inputs/schedule_DRAFT.json').read_text());self.old_slots=json.loads((cloud_driver.ROOT/'inputs/schedule_PRE_10AM.json').read_text());service.init(self.root,self.old,self.prompts,self.old_slots,self.f.remote)
        self.anchor=core.digest(core.canonical(self.f.remote.head()));self.now=core.utc_epoch('2026-11-12T08:00:00Z')
    def tearDown(self):self.tmp.cleanup();self.f.tmp.cleanup()
    def amend(self):return cloud_driver.amend_schedule(self.root,self.old,self.new,self.prompts,self.slots,self.f.remote,now=self.now)
    def test_preserves_and_restores(self):
        self.amend();self.f.remote.verify(self.root,self.new);cloud_driver.verify_chain(self.f.remote,self.anchor)
        target=pathlib.Path(self.tmp.name)/'fresh'/core.STUDY
        result=cloud_driver.prepare(target,self.new,self.prompts,self.slots,self.f.remote,'preflight',1,anchor=self.anchor,now=self.now)
        self.assertEqual(result['summary']['attempts'],0);self.assertTrue((target/'manifests'/(self.old['manifest_sha256']+'.json')).exists())
    def test_reject_non_timing_slot_change(self):
        self.slots[0]['prompt_id']='OTHER'
        with self.assertRaises(RuntimeError):self.amend()
    def test_reject_other_change(self):
        self.new['provider_cap_micro_usd']-=1;self.new['manifest_sha256']=core.manifest_hash(self.new)
        with self.assertRaises(RuntimeError):self.amend()
    def test_reject_started(self):
        l=core.Ledger(self.root,self.old);l.db.execute("INSERT INTO rounds VALUES (1,'active',1,NULL,NULL)");storage.backup(self.root,l,self.f.remote,self.old);l.close()
        with self.assertRaises(RuntimeError):self.amend()
    def test_preserves_diagnostics(self):
        # Existing qualification receipts/charges must survive the schedule amendment.
        l=core.Ledger(self.root,self.old);data=core.canonical({'fixture':True});sha=core.write_once(self.root/'raw/fixture.json',data)
        l.db.execute("INSERT INTO attempts(id,slot,endpoint,kind,n,status,reserved,accounted,start,raw_path,raw_hash) VALUES ('q','q','openai_api','diagnostic',1,'complete',100,85,1,'raw/fixture.json',?)",(sha,));storage.backup(self.root,l,self.f.remote,self.old);l.close()
        self.amend();info=cloud_driver.safe_ledger(self.root,self.new);self.assertEqual(info['summary']['attempts'],1);self.assertEqual(info['summary']['committed_or_held_micro_usd'],85)
if __name__=='__main__':unittest.main()
