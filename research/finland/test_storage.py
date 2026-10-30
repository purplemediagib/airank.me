import unittest,storage
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
