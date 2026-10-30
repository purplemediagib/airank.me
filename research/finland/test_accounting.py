import unittest,accounting,runner,tempfile,pathlib
class AccountingTests(unittest.TestCase):
    def config(self):return {'model':runner.MODEL,'max_tool_calls':2,'max_output_tokens':1500,'usage_upper_bound_accounting_verified':True}
    def test_conservative_not_actual(self):
        c=accounting.cost({'usage':{'input_tokens':1000,'output_tokens':1500}},'openai_responses',self.config());self.assertIsNone(c['actual']);self.assertEqual(c['accounted'],29200);self.assertEqual(c['basis'],'conservative_usage_upper_bound')
    def test_no_cache_discount_or_missing_tool_discount(self):
        c=accounting.cost({'usage':{'input_tokens':17000,'output_tokens':1500,'input_tokens_details':{'cached_tokens':17000}},'output':[]},'openai_responses',self.config());self.assertEqual(c['accounted'],35600)
    def test_invalid_tokens_unknown(self):
        for v in [True,-1,1.2,None]:self.assertIsNone(accounting.cost({'usage':{'input_tokens':v,'output_tokens':10}},'openai_responses',self.config())['accounted'])
    def test_observed_tool_cap_deviation_holds(self):
        r={'usage':{'input_tokens':100,'output_tokens':100},'output':[{'type':'web_search_call'}]*3}
        self.assertEqual(accounting.cost(r,'openai_responses',self.config())['basis'],'usage_cap_deviation')
    def test_missing_usage_unknown(self):self.assertEqual(accounting.cost({},'openai_responses',self.config())['basis'],'unknown')
    def test_wrong_model_unknown(self):
        c=self.config();c['model']='changed';self.assertIsNone(accounting.cost({'usage':{'input_tokens':1,'output_tokens':1}},'openai_responses',c)['accounted'])
    def test_output_cap_deviation(self):self.assertEqual(accounting.cost({'usage':{'input_tokens':1,'output_tokens':1501}},'openai_responses',self.config())['basis'],'usage_cap_deviation')
    def test_kimi_finite_cost(self):
        for v in [float('nan'),float('inf'),-1,True]:self.assertIsNone(accounting.cost({'usage':{'cost':v}},'kimi_candidate',{'usage_cost_verified_all_in':True})['actual'])
    def test_kimi_cost_roundup(self):self.assertEqual(accounting.cost({'usage':{'cost':'0.0000001'}},'kimi_candidate',{'usage_cost_verified_all_in':True})['actual'],1)
    def test_ledger_accounted_not_invoice(self):
        with tempfile.TemporaryDirectory() as t:
            l=runner.Ledger(pathlib.Path(t)/'x');a=l.reserve('s');l.finish(a,'complete',{},accounted=29200,accounting_basis='conservative_usage_upper_bound');r=l.rows()[0];self.assertIsNone(r['actual']);self.assertEqual(r['accounted'],29200);l.db.close()
if __name__=='__main__':unittest.main()
