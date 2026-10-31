import unittest,storage,tempfile,pathlib,service,runner,sqlite3
class StorageTests(unittest.TestCase):
    def setUp(self):
        self.files={}
        def mock(method,url,data=None):
            if method=='PUT':self.files[url]=data;return 201,b''
            return (200,self.files[url]) if url in self.files else (404,b'')
        self.s=storage.BunnyBackup('storage.bunnycdn.com','fake-zone','FAKE','study',mock)
    def test_marker_recovery_matching_identity(self):
        identity={'study_id':'study','provider_cap_micro_usd':38000000}
        self.s.ensure_marker(identity);self.s.ensure_marker(identity)
        with self.assertRaises(storage.StorageError):self.s.ensure_marker({**identity,'other':'different'})
    def test_remote_head_detects_stale_ledger(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t)/'data';service.initialize(root,'study');l=service.open_study(root,'study',{})
            service.backup(root,l,'initial-test',self.s);self.s.verify_head(root)
            old=root/'old.sqlite'
            with sqlite3.connect(old) as d:l.db.backup(d)
            l.db.execute("INSERT INTO config VALUES ('new_request_evidence','must_not_disappear')")
            with self.assertRaises(storage.StorageError):self.s.verify_head(root)
            service.backup(root,l,'after-request',self.s);self.s.verify_head(root)
            with sqlite3.connect(old) as olddb:olddb.backup(l.db)
            with self.assertRaises(storage.StorageError):self.s.verify_head(root)
            l.db.close()
    def test_remote_head_mismatch_blocks_advance(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t)/'data';service.initialize(root,'study');l=service.open_study(root,'study',{})
            service.backup(root,l,'initial-test',self.s)
            (root/'remote-head.json').write_text('{}')
            with self.assertRaises(storage.StorageError):service.backup(root,l,'bad-next',self.s)
            l.db.close()
    def test_verified_upload(self):self.assertTrue(self.s.put_verified('a.json',b'hello')['verified'])
    def test_immutable_remote(self):
        self.s.put_verified('a',b'a')
        with self.assertRaises(storage.StorageError):self.s.put_verified('a',b'b')
    def test_marker_no_reset(self):
        self.s.create_marker({'study_id':'study','provider_cap_micro_usd':38000000});self.s.verify_marker('study')
        with self.assertRaises(storage.StorageError):self.s.create_marker({'study_id':'study'})
    def test_untrusted_host(self):
        with self.assertRaises(storage.StorageError):storage.BunnyBackup('evil.test','zone','FAKE','study')
    def test_path_traversal(self):
        with self.assertRaises(storage.StorageError):self.s.put_verified('../a',b'a')
    def test_readback_failure(self):
        self.s.transport=lambda method,url,data=None:(404,b'') if method=='GET' else (201,b'')
        with self.assertRaises(storage.StorageError):self.s.put_verified('a',b'a')
if __name__=='__main__':unittest.main()

class StorageStageTests(unittest.TestCase):
    def test_upload_failure_reports_fixed_stage_without_body(self):
        def mock(method,url,data=None):
            if method=='GET':return 404,b''
            raise storage.StorageError('NEVER LOG PRIVATE BODY',503,'PUT')
        s=storage.BunnyBackup('se.storage.bunnycdn.com','synthetic','FAKE','study',mock)
        with self.assertRaises(storage.StorageError) as caught:s.put_verified('a.json',b'{}')
        from types import SimpleNamespace
        result=service.safe_failure(caught.exception,SimpleNamespace(study_id='study'))
        self.assertEqual(result['storage_stage'],'artifact_put')
        self.assertEqual(result['storage_http_status'],503)
        self.assertNotIn('PRIVATE',str(result))

    def test_readback_failure_stage(self):
        count=0
        def mock(method,url,data=None):
            nonlocal count
            if method=='PUT':return 201,b''
            count+=1
            return (404,b'') if count==1 else (200,b'wrong')
        s=storage.BunnyBackup('se.storage.bunnycdn.com','synthetic','FAKE','study',mock)
        with self.assertRaises(storage.StorageError):s.put_verified('a.json',b'{}')
        self.assertEqual(storage.LAST_STAGE,'artifact_readback_get')

class CheckpointRecoveryTests(unittest.TestCase):
    def setup_fixture(self,root,unknown=False):
        import json,hashlib,io,tarfile
        service.initialize(root,'study')
        (root/'qualification.lock').touch()
        l=service.open_study(root,'study',{'openai_responses':{'verified':True,'evidence':'synthetic','micro_usd':1500000}})
        aid=l.reserve_study('diagnostic:openai_responses:synthetic','openai_responses','diagnostic')
        body=b'{"response":"synthetic"}';(root/'raw'/'synthetic.json').write_bytes(body)
        l.finish(aid,'complete',{'raw_path':'raw/synthetic.json','raw_hash':hashlib.sha256(body).hexdigest()},actual=12);l.db.close()
        if unknown:
            with sqlite3.connect(root/'ledger.sqlite') as db:db.execute("UPDATE attempts SET status='reserved',actual=NULL")
            db.close()
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as tar:
            for name in ('identity.json','ledger.sqlite','raw'):tar.add(root/name,arcname=name)
        archive=stream.getvalue();base='https://se.storage.bunnycdn.com/synthetic/study/'
        remote=storage.BunnyBackup('se.storage.bunnycdn.com','synthetic','FAKE','study')
        head={'sequence':31,'sha256':hashlib.sha256(archive).hexdigest(),'ledger_fingerprint':remote.ledger_fingerprint(root),'archive':base+storage.RECOVERY_ARCHIVE_NAME}
        files={base+'study-marker.json':(root/'identity.json').read_bytes(),head['archive']:archive,base+'latest-backup.json':json.dumps(head).encode()}
        (root/'remote-head.json').write_text(json.dumps({**head,'sequence':30}))
        def transport(method,url,data=None):
            self.assertEqual(method,'GET')
            return (200,files[url]) if url in files else (404,b'')
        remote.transport=transport
        return remote,head,files
    def test_recovery_verified_idempotent_preserves_financial_data(self):
        import json
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t)/'study';remote,head,files=self.setup_fixture(root)
            live=sqlite3.connect(root/'ledger.sqlite')
            live.execute('PRAGMA journal_mode=WAL')
            live.execute("INSERT INTO config VALUES ('temporary_probe_test','true')");live.commit()
            live.execute("DELETE FROM config WHERE k='temporary_probe_test'");live.commit()
            self.addCleanup(live.close)
            before=storage.snapshot_fingerprint(root);raw=(root/'raw/synthetic.json').read_bytes()
            financial=lambda:{p.name:p.read_bytes() for p in root.glob('ledger.sqlite*')}
            before_bytes=financial()
            with patch.object(storage,'RECOVERY_ARCHIVE_SHA256',head['sha256']),patch.object(storage,'RECOVERY_LEDGER_SHA256',head['ledger_fingerprint']):
                result=storage.reconcile_checkpoint(root,remote,'study')
                self.assertFalse(result['already_current'])
                self.assertTrue(storage.reconcile_checkpoint(root,remote,'study')['already_current'])
            self.assertEqual(before,storage.snapshot_fingerprint(root));self.assertEqual(raw,(root/'raw/synthetic.json').read_bytes())
            self.assertEqual(before_bytes,financial())
            self.assertEqual(json.loads((root/'remote-head.json').read_text()),head)
            self.assertEqual(len(list(root.glob('remote-head-before-reconcile-*.json'))),1)
    def test_recovery_bad_archive_or_raw_stops_before_pointer(self):
        from unittest.mock import patch
        for mode in ('archive','raw','ledger','remote_change'):
            with tempfile.TemporaryDirectory() as t:
                root=pathlib.Path(t)/'study';remote,head,files=self.setup_fixture(root)
                old=(root/'remote-head.json').read_bytes()
                if mode=='archive':files[head['archive']]=b'bad'
                if mode=='raw':(root/'raw/synthetic.json').write_bytes(b'bad')
                if mode=='ledger':
                    with sqlite3.connect(root/'ledger.sqlite') as db:db.execute("INSERT INTO config VALUES ('changed','true')")
                if mode=='remote_change':
                    original=remote.head;calls=[]
                    def changed():
                        calls.append(1)
                        return original() if len(calls)==1 else {**head,'sequence':32}
                    remote.head=changed
                with patch.object(storage,'RECOVERY_ARCHIVE_SHA256',head['sha256']),patch.object(storage,'RECOVERY_LEDGER_SHA256',head['ledger_fingerprint']):
                    with self.assertRaises(storage.StorageError):storage.reconcile_checkpoint(root,remote,'study')
                self.assertEqual((root/'remote-head.json').read_bytes(),old)
    def test_failed_atomic_replace_preserves_prior_pointer(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t);(root/'remote-head.json').write_bytes(b'old')
            with patch.object(storage.os,'replace',side_effect=OSError(28,'PRIVATE')):
                with self.assertRaises(OSError):storage.persist_local_head(root,b'new')
            self.assertEqual((root/'remote-head.json').read_bytes(),b'old')
            self.assertEqual(list(root.glob('*.tmp')),[])

    def test_unknown_archived_attempt_cannot_be_repaired(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t)/'study';remote,head,files=self.setup_fixture(root,unknown=True)
            before=(root/'remote-head.json').read_bytes()
            with patch.object(storage,'RECOVERY_ARCHIVE_SHA256',head['sha256']),patch.object(storage,'RECOVERY_LEDGER_SHA256',head['ledger_fingerprint']):
                with self.assertRaisesRegex(storage.StorageError,'Unresolved archived'):
                    storage.reconcile_checkpoint(root,remote,'study')
            self.assertEqual(before,(root/'remote-head.json').read_bytes())
