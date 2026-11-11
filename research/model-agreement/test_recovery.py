import io,json,pathlib,tarfile,unittest
import core,recovery,job_driver,service
from test_runner import Fixture,P,S,T
class RecoveryTests(unittest.TestCase):
    def setUp(self):self.f=Fixture();self.target=pathlib.Path(self.f.tmp.name)/'fresh'/core.STUDY
    def tearDown(self):self.f.tmp.cleanup()
    def restore(self):return recovery.restore(self.target,self.f.m,self.f.remote,core.digest(core.canonical(self.f.remote.head())))
    def test_valid_preserves_ledger(self):
        self.f.execute();self.restore();l=core.Ledger(self.target,self.f.m);self.assertEqual(l.summary()['attempts'],1);l.close()
    def test_no_reset(self):
        self.restore()
        with self.assertRaises(RuntimeError):self.restore()
    def test_reviewed_head(self):
        with self.assertRaises(RuntimeError):recovery.restore(self.target,self.f.m,self.f.remote,'0'*64)
    def test_corrupt_archive(self):
        self.f.objects[self.f.remote.head()['archive']]=b'broken'
        with self.assertRaises(RuntimeError):self.restore()
    def malicious(self,name,kind=None):
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w:gz') as t:
            x=tarfile.TarInfo(name)
            if kind:x.type=kind;x.linkname='/tmp/evil'
            t.addfile(x,io.BytesIO(b''))
        b=buf.getvalue();h=self.f.remote.head();h['sha256']=core.digest(b);h['archive']='snapshot-'+h['sha256']+'.tar.gz';self.f.objects[h['archive']]=b;self.f.objects['latest-backup.json']=core.canonical(h)
    def test_traversal(self):
        self.malicious('../escape')
        with self.assertRaises(RuntimeError):self.restore()
    def test_symlink(self):
        self.malicious('ledger.sqlite',tarfile.SYMTYPE)
        with self.assertRaises(RuntimeError):self.restore()
    def test_fingerprint(self):
        h=self.f.remote.head();h['state_sha256']='0'*64;self.f.objects['latest-backup.json']=core.canonical(h)
        with self.assertRaises(RuntimeError):self.restore()
    def test_round_selected(self):
        self.f.release();calls=[]
        def tick(*args,**kwargs):calls.append(kwargs);return {'state':'finished'}
        job_driver.run_round(self.f.root,self.f.m,P,S,self.f.remote,1,T+9000,clock=lambda:T,tick=tick)
        self.assertEqual(calls[0]['selected_round'],1);self.assertEqual(calls[0]['dispatch_deadline'],T+9000)
    def test_full_window_fit(self):
        self.f.release()
        with self.assertRaises(RuntimeError):job_driver.run_round(self.f.root,self.f.m,P,S,self.f.remote,1,T+100,clock=lambda:T)
    def test_missed_round(self):
        self.f.release()
        with self.assertRaises(RuntimeError):job_driver.run_round(self.f.root,self.f.m,P,S,self.f.remote,1,T+9000,clock=lambda:T+601)
    def test_tick_does_not_enter_other_round(self):
        self.f.release()
        with core.locked(self.f.root):
            l=core.Ledger(self.f.root,self.f.m);l.db.execute('INSERT INTO rounds VALUES (1,?,?,?,?)',('complete',T,T,None));import storage;storage.backup(self.f.root,l,self.f.remote,self.f.m);l.close()
        result=service.tick(self.f.root,self.f.m,P,S,self.f.remote,now=T,selected_round=1)
        self.assertEqual(result['state'],'finished')
if __name__=='__main__':unittest.main()
