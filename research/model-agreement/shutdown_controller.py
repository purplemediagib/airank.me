"""External watchdog, never imported/run by collection image. Defaults to dry-run."""
import argparse, json, math, os, time, urllib.request
from decimal import Decimal, ROUND_CEILING
from core import STUDY, atomic, canonical, utc_epoch
PROTECTED={'EbojLQRFoDHT4u5','zWhBpYT7UDGMOWK','s7YfslyUmE8U464'}
BASE='https://api.bunny.net/mc/apps/'

def number(p,k):
    v=Decimal(str(p[k]))
    if not v.is_finite() or v<0: raise ValueError('Invalid nonnegative value: '+k)
    return v

def hosting_bound(p):
    """Conditional upper bound, not a claim a best-effort watchdog guarantees shutdown."""
    for k in ('resource_limits_verified','finite_lifetime_verified','network_cap_verified','storage_retention_verified','no_ip_no_volumes_verified','prices_verified'):
        if p.get(k) is not True:raise ValueError('Unverified hosting gate: '+k)
    if p.get('replicas')!=1 or p.get('regions')!=1:raise ValueError('Singleton required')
    if not p.get('pricing_source') or not p.get('pricing_checked_utc'):raise ValueError('Missing pricing evidence')
    seconds=number(p,'max_lifetime_seconds')+number(p,'shutdown_grace_seconds')
    if seconds<=0:raise ValueError('Finite positive lifetime required')
    hours=seconds/3600
    # Whole-hour rounding and 64MiB blocks are deliberately conservative.
    memory=(number(p,'max_memory_gib')*16).to_integral_value(rounding=ROUND_CEILING)/16
    cpu=hours*number(p,'max_cpu_cores')*number(p,'cpu_usd_core_hour')
    ram=hours.to_integral_value(rounding=ROUND_CEILING)*memory*number(p,'ram_usd_gib_hour')
    net=number(p,'max_egress_gb')*number(p,'egress_usd_gb')
    storage=number(p,'max_archive_gb')*number(p,'archive_usd_gb_month')*number(p,'retention_months').to_integral_value(rounding=ROUND_CEILING)
    subtotal=cpu+ram+net+storage+number(p,'minimum_fee_usd')+number(p,'controller_cost_usd')+number(p,'fixed_fee_usd')
    total=subtotal*(1+number(p,'tax_fraction'))+number(p,'rounding_allowance_usd')
    micro=int((total*1000000).to_integral_value(rounding=ROUND_CEILING))
    if micro>p['hosting_allocation_micro_usd']:raise ValueError('Hosting allocation exceeded')
    if micro+p['provider_allocation_micro_usd']+p['contingency_micro_usd']>40000000:raise ValueError('Total USD40 exceeded')
    return {'conditional_bound_micro_usd':micro,'basis':'verified resource and lifetime ceilings; not an invoice','components_usd':{k:str(v) for k,v in dict(cpu=cpu,ram=ram,network=net,archive=storage).items()}}

def guard(p):
    if p.get('study_id')!=STUDY:raise ValueError('Wrong study')
    app=p.get('app_id','')
    if not app.isalnum() or app in PROTECTED:raise ValueError('App not an isolated research target')
    if p.get('expected_name')!=STUDY:raise ValueError('Unexpected research name')
    for k in ('identity_verified','status_schema_verified','external_controller_verified'):
        if p.get(k) is not True:raise ValueError('Closed controller gate: '+k)
    # Fields/values must be read from actual API docs/response before activation.
    if not p.get('id_field') or not p.get('name_field') or not p.get('status_field') or not p.get('stopped_values'):raise ValueError('Missing verified status schema')
    utc_epoch(p['stop_at_utc'])
    return app

def identity(d,p):
    if d.get(p['id_field'])!=p['app_id'] or d.get(p['name_field'])!=p['expected_name']:raise ValueError('Remote identity mismatch')

def shutdown(p,api,now=None):
    app=guard(p);now=time.time() if now is None else now
    if now<utc_epoch(p['stop_at_utc']):return {'state':'not_due','paid_calls':0}
    d=api('GET',app);identity(d,p)
    if d.get(p['status_field']) in p['stopped_values']:return {'state':'verified_stopped','app_id':app,'already_stopped':True}
    # One POST per invocation, no delete/deploy. An ambiguous POST is followed by readback.
    uncertain=False
    try:api('POST',app+'/undeploy')
    except Exception:uncertain=True
    d=api('GET',app);identity(d,p)
    if d.get(p['status_field']) not in p['stopped_values']:raise RuntimeError('Shutdown unverified; escalate immediately, hosting may continue')
    return {'state':'verified_stopped','app_id':app,'post_outcome_uncertain':uncertain}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('Redirect refused')

def http_api(method,path):
    req=urllib.request.Request(BASE+path,data=b'' if method=='POST' else None,method=method,headers={'AccessKey':os.environ['BUNNY_CONTROL_KEY']})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as r:
        b=r.read(1000000)
        return json.loads(b) if b else {}

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('policy');a.add_argument('--execute',action='store_true');a.add_argument('--receipt');args=a.parse_args()
    p=json.load(open(args.policy));guard(p);bound=hosting_bound(p['hosting'])
    if args.execute:
        if not args.receipt:raise ValueError('Durable external receipt path required')
        result=shutdown(p,http_api);atomic(args.receipt,canonical(result));print(json.dumps(result))
    else:print(json.dumps({'state':'dry_run_only','hosting':bound}))
