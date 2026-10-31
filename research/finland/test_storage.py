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
