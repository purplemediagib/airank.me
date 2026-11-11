import unittest
from shutdown_controller import *
class ShutdownTests(unittest.TestCase):
    def policy(self):
        return dict(study_id=STUDY,app_id='newResearch123',expected_name=STUDY,identity_verified=True,status_schema_verified=True,external_controller_verified=True,id_field='id',name_field='name',status_field='status',stopped_values=['stopped'],stop_at_utc='2026-11-11T00:00:00Z')
    def response(self,status='running'):return dict(id='newResearch123',name=STUDY,status=status)
    def test_protected(self):
        for app in PROTECTED:
            p=self.policy();p['app_id']=app
            with self.assertRaises(ValueError):guard(p)
    def test_closed_schema(self):
        p=self.policy();p['status_schema_verified']=False
        with self.assertRaises(ValueError):guard(p)
    def test_not_due_no_network(self):
        self.assertEqual(shutdown(self.policy(),lambda *_:self.fail('network'),0)['state'],'not_due')
    def test_exact_action(self):
        calls=[]
        def api(m,p):
            calls.append((m,p));return self.response('stopped' if len(calls)==3 else 'running')
        self.assertEqual(shutdown(self.policy(),api,9999999999)['state'],'verified_stopped')
        self.assertEqual(calls,[('GET','newResearch123'),('POST','newResearch123/undeploy'),('GET','newResearch123')])
    def test_wrong_identity_no_post(self):
        with self.assertRaises(ValueError):shutdown(self.policy(),lambda *_:dict(id='production'),9999999999)
    def test_stopped_no_post(self):
        self.assertTrue(shutdown(self.policy(),lambda m,p:self.response('stopped') if m=='GET' else self.fail(),9999999999)['already_stopped'])
    def test_ambiguous_readback(self):
        n=[]
        def api(m,p):
            n.append(m)
            if m=='POST':raise TimeoutError()
            return self.response('stopped' if len(n)>1 else 'running')
        self.assertTrue(shutdown(self.policy(),api,9999999999)['post_outcome_uncertain'])
    def test_failed_stop(self):
        with self.assertRaises(RuntimeError):shutdown(self.policy(),lambda *_:self.response(),9999999999)
    def host(self):
        p={k:True for k in ('resource_limits_verified','finite_lifetime_verified','network_cap_verified','storage_retention_verified','no_ip_no_volumes_verified','prices_verified')}
        p.update(replicas=1,regions=1,pricing_source='test fixture',pricing_checked_utc='2026-11-11T00:00:00Z',max_lifetime_seconds=3600,shutdown_grace_seconds=60,max_memory_gib=1,max_cpu_cores=1,cpu_usd_core_hour='.02',ram_usd_gib_hour='.005',max_egress_gb=1,egress_usd_gb='.06',max_archive_gb=1,archive_usd_gb_month='.01',retention_months=1,minimum_fee_usd=1,controller_cost_usd=0,fixed_fee_usd=0,tax_fraction='.2',rounding_allowance_usd='.1',hosting_allocation_micro_usd=5000000,provider_allocation_micro_usd=30000000,contingency_micro_usd=5000000)
        return p
    def test_host_math(self):self.assertEqual(hosting_bound(self.host())['conditional_bound_micro_usd'],1420400)
    def test_unknown_lifetime(self):
        p=self.host();p['finite_lifetime_verified']=False
        with self.assertRaises(ValueError):hosting_bound(p)
    def test_budget_overflow(self):
        p=self.host();p['max_lifetime_seconds']=999999999
        with self.assertRaises(ValueError):hosting_bound(p)
    def test_nonfinite(self):
        p=self.host();p['max_cpu_cores']='NaN'
        with self.assertRaises(ValueError):hosting_bound(p)
if __name__=='__main__':unittest.main()
