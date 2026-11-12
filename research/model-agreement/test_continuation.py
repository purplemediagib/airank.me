import copy,functools,json,unittest
import core,service,storage,continuation,adapters
from test_runner import Fixture,P,S,T,response,freeze
START=core.utc_epoch(continuation.WINDOW['start_utc'])
class ContinuationTests(unittest.TestCase):
 def setUp(self):
  self.f=Fixture();self.f.release()
  self.slot=S[0];service.execute(self.f.root,self.f.m,P,S,self.slot,'primary',self.f.remote,transport=lambda ep,*a:response(ep),clock=lambda:T,key_loader=lambda _: 'fixture')
  l=core.Ledger(self.f.root,self.f.m);l.db.execute("INSERT INTO rounds VALUES (1,'active',?,NULL,NULL)",(T,));storage.backup(self.f.root,l,self.f.remote,self.f.m);self.before=l.rows();l.close()
  self.new=continuation.approved_manifest(self.f.m)
 def tearDown(self):self.f.tmp.cleanup()
 def amend(self):return continuation.amend(self.f.root,self.f.m,self.new,P,S,self.f.remote,now=START-300)
 def test_preserves_all_attempts_and_remote(self):
  self.amend();l=core.Ledger(self.f.root,self.new);self.assertEqual(l.rows(),self.before);l.close();self.f.remote.verify(self.f.root,self.new)
 def test_reject_model_change(self):
  self.new['endpoints']['openai_api']['model']='different';freeze(self.new)
  with self.assertRaises(RuntimeError):self.amend()
 def test_reject_unresolved(self):
  l=core.Ledger(self.f.root,self.f.m);l.db.execute('UPDATE attempts SET accounted=NULL WHERE slot=?',(self.slot['slot_id'],));storage.backup(self.f.root,l,self.f.remote,self.f.m);l.close()
  with self.assertRaises(RuntimeError):self.amend()
 def test_reject_halt(self):
  l=core.Ledger(self.f.root,self.f.m);l.halt('requires_review');storage.backup(self.f.root,l,self.f.remote,self.f.m);l.close()
  with self.assertRaises(RuntimeError):self.amend()
 def test_reject_late_amend(self):
  with self.assertRaises(RuntimeError):continuation.amend(self.f.root,self.f.m,self.new,P,S,self.f.remote,now=START+601)
 def test_no_repeated_continuation(self):
  self.amend();fn=lambda *a,**k:{'state':'blocked'}
  continuation.run(self.f.root,self.new,P,S,self.f.remote,START+7200,clock=lambda:START,tick=fn)
  with self.assertRaises(RuntimeError):continuation.run(self.f.root,self.new,P,S,self.f.remote,START+7200,clock=lambda:START,tick=fn)
 def test_untouched_only_skips_retryable(self):
  self.amend();l=core.Ledger(self.f.root,self.new);l.db.execute("UPDATE attempts SET status='retryable',retry_at=0 WHERE slot=?",(self.slot['slot_id'],));storage.backup(self.f.root,l,self.f.remote,self.new);l.close();seen=[]
  def fake(root,m,p,s,slot,*a,**kw):seen.append(slot['slot_id']);return {}
  service.tick(self.f.root,self.new,P,S,self.f.remote,now=START,selected_round=1,untouched_only=True,execute_fn=fake)
  self.assertEqual(seen,[S[1]['slot_id']])
 def test_cost_excess_does_not_halt(self):
  self.amend();l=core.Ledger(self.f.root,self.new)
  aid=l.claim(S[1]['slot_id'],S[1]['endpoint'],'primary',100000000,self.new,START)
  l.finish(aid,'complete','raw/synthetic.json','0'*64,100000001,'synthetic',START+1)
  self.assertFalse(l.summary()['halted']);l.close()
 def test_unknown_still_halts(self):
  self.amend();l=core.Ledger(self.f.root,self.new);aid=l.claim(S[1]['slot_id'],S[1]['endpoint'],'primary',100000000,self.new,START);l.finish(aid,'unknown','raw/synthetic.json','0'*64,None,'unknown',START+1);self.assertTrue(l.summary()['halted']);l.close()
 def test_kimi_high_tokens_reported_cost(self):
  c=self.new['endpoints']['kimi_api'];r=response('kimi_api');r['usage']['prompt_tokens']=c['verified_max_total_input_tokens']+1
  self.assertEqual(adapters.account('kimi_api',r,c,False),(10000,'provider_reported_charge'))
  with self.assertRaises(ValueError):adapters.account('kimi_api',r,c)
 def test_19utc_only(self):self.assertEqual(self.new['rounds'][0]['start_utc'],'2026-11-12T19:00:00Z');self.assertEqual(self.new['rounds'][1:],self.f.m['rounds'][1:])
if __name__=='__main__':unittest.main()

class ReconciliationTests(unittest.TestCase):
 def setUp(self):
  self.f=Fixture();self.f.release()
  selected=[s for s in S if s['round']==1 and s['slot_id']!=continuation.RECONCILE_ATTEMPT.rsplit(':a',1)[0]][:19]
  for slot in selected:service.execute(self.f.root,self.f.m,P,S,slot,'primary',self.f.remote,transport=lambda ep,*a:response(ep),clock=lambda:T,key_loader=lambda _: 'fixture')
  slot=next(s for s in S if s['slot_id']==continuation.RECONCILE_ATTEMPT.rsplit(':a',1)[0])
  def bad(ep,*a):
   r=response(ep);r['usage'].update(completion_tokens=4083,cost=.02094904);return r
  service.execute(self.f.root,self.f.m,P,S,slot,'primary',self.f.remote,transport=bad,clock=lambda:T,key_loader=lambda _: 'fixture')
  l=core.Ledger(self.f.root,self.f.m);self.original=l.rows();r=next(r for r in self.original if r['id']==continuation.RECONCILE_ATTEMPT);l.close()
  self.oldraw=continuation.RECONCILE_RAW_SHA;self.oldhead=continuation.RECONCILE_HEAD_SHA
  continuation.RECONCILE_RAW_SHA=r['raw_hash'];continuation.RECONCILE_HEAD_SHA=core.digest(core.canonical(self.f.remote.head()))
 def tearDown(self):continuation.RECONCILE_RAW_SHA=self.oldraw;continuation.RECONCILE_HEAD_SHA=self.oldhead;self.f.tmp.cleanup()
 def test_exact_receipt_corrected_and_idempotent(self):
  result=continuation.reconcile(self.f.root,self.f.m,P,S,self.f.remote,now=START-300);self.assertEqual(result['ledger_accounted_micro_usd'],20950)
  l=core.Ledger(self.f.root,self.f.m);new=l.rows();summary=l.summary();l.close();self.assertEqual(summary['unresolved'],0);self.assertFalse(summary['halted'])
  for a,b in zip(self.original,new):
   if a['id']==continuation.RECONCILE_ATTEMPT:
    self.assertEqual(b['accounted'],20950);self.assertEqual(b['status'],'complete')
    for k in ('raw_path','raw_hash','start','end','slot','reserved'):self.assertEqual(a[k],b[k])
   else:self.assertEqual(a,b)
  self.assertTrue(continuation.reconcile(self.f.root,self.f.m,P,S,self.f.remote)['already_corrected'])
 def test_wrong_head_refused(self):
  continuation.RECONCILE_HEAD_SHA='0'*64
  with self.assertRaises(RuntimeError):continuation.reconcile(self.f.root,self.f.m,P,S,self.f.remote)
 def test_wrong_raw_refused(self):
  continuation.RECONCILE_RAW_SHA='0'*64
  with self.assertRaises(RuntimeError):continuation.reconcile(self.f.root,self.f.m,P,S,self.f.remote)
 def test_wrong_charge_refused(self):
  # Wrong expected actual cannot silently normalize to another provider charge.
  from unittest.mock import patch
  with patch('continuation.Decimal',side_effect=ValueError('fixture')):
   with self.assertRaises(ValueError):continuation.reconcile(self.f.root,self.f.m,P,S,self.f.remote)
 def test_blocked_run_never_success(self):
  with self.assertRaises(RuntimeError):continuation.verify_outcome(self.f.root,self.f.m,{'state':'blocked'},'run')
