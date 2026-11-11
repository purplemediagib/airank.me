"""Nonpaid private storage validation or one-time initialization. No provider credentials."""
import argparse,json,os,pathlib
from urllib.request import Request,build_opener
import core,service,storage

def zone_empty(remote):
    # Dedicated zone must have no files/directories, not merely an unused study prefix.
    zone_url=remote.base.rsplit(core.STUDY+'/',1)[0]
    with build_opener(storage.NoRedirect).open(Request(zone_url,headers={'AccessKey':remote.key}),timeout=45) as r:
        listing=json.loads(r.read(1000000))
    if not isinstance(listing,list):raise RuntimeError('Unrecognized private zone listing')
    return listing==[]

def initialize(root,m,prompts,slots,remote,empty_check=zone_empty):
    if m.get('protocol_frozen') is not True:raise RuntimeError('Finalize immutable protocol before init')
    # This operation never dispatches providers, even when initializing a future qualification manifest.
    if not empty_check(remote):raise RuntimeError('Dedicated storage zone not empty; never reset')
    return service.init(root,m,prompts,slots,remote)

def main():
    os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('operation',choices=['storage-check','init']);a=p.parse_args()
    remote=storage.from_env()
    if a.operation=='storage-check':print(json.dumps({'storage_access_verified':True,'empty_zone':zone_empty(remote),'paid_calls':0}));return
    if os.environ.get('RESEARCH_INIT_ENABLED')!='reviewed-once':raise RuntimeError('Init approval gate closed')
    m,prompts,slots=service.load(str(pathlib.Path(__file__).parent/'manifest_RELEASE.json'))
    initialize(pathlib.Path(os.environ['RESEARCH_DATA_DIR']),m,prompts,slots,remote)
    print(json.dumps({'initialized':True,'paid_calls':0}))
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'state':'blocked','error_type':type(e).__name__,'paid_calls':0}));raise SystemExit(2)
