"""Generic immutable private-job bootstrap. No embedded private study data."""
import argparse,ctypes,fcntl,gzip,hashlib,io,json,os,pathlib,re,resource,signal,stat,subprocess,sys,tarfile,time
from datetime import datetime,timezone
from urllib.parse import urlsplit,unquote
from urllib.request import Request,build_opener,HTTPRedirectHandler
from verify_inputs import verify,TrustPins,MAX_POLICY_BYTES,MAX_BUNDLE_BYTES,MAX_EXPANDED_BYTES

class Closed(RuntimeError):pass
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*a,**k):raise Closed('redirect')
def digest(b):return hashlib.sha256(b).hexdigest()
def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':')).encode()
def require(ok):
    if not ok:raise Closed('gate')
def unique(pairs):
    out={}
    for k,v in pairs:
        require(k not in out);out[k]=v
    return out

def gate(e,observed):
    require(e.get('GITHUB_ACTIONS')=='true' and e.get('GITHUB_EVENT_NAME')=='workflow_dispatch')
    require(e.get('RUNNER_ENVIRONMENT')=='github-hosted')
    for actual,approved in [('GITHUB_REPOSITORY','REVIEWED_REPOSITORY'),('GITHUB_REF_NAME','REVIEWED_BRANCH'),('GITHUB_ACTOR','REVIEWED_ACTOR')]:
        require(bool(e.get(approved)) and e.get(actual)==e[approved])
    require(bool(e.get('REVIEWED_ENVIRONMENT')) and bool(e.get('REVIEWED_CONCURRENCY_GROUP')))
    sha=e.get('REVIEWED_BOOTSTRAP_SHA','')
    require(bool(re.fullmatch('[0-9a-f]{40}',sha)) and observed==sha==e.get('GITHUB_SHA'))
    for name in ('REVIEWED_PRIVATE_BUNDLE_SHA256','REVIEWED_PRIVATE_POLICY_SHA256','REVIEWED_PRIVATE_CONTRACT_SHA256'):
        require(bool(re.fullmatch('[0-9a-f]{64}',e.get(name,''))))

def read_file(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        require(stat.S_ISREG(os.fstat(f.fileno()).st_mode));b=f.read(limit+1)
    require(len(b)<=limit);return b

def new_file(path,b):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())

def fetch(url,key,limit,opener=None):
    u=urlsplit(url)
    require(u.scheme=='https' and bool(re.fullmatch(r'(?:[a-z]{2}\.)?storage\.bunnycdn\.com',u.hostname or '')))
    require(u.port in (None,443) and not u.username and not u.password and not u.query and not u.fragment)
    require(u.path.startswith('/') and '..' not in pathlib.PurePosixPath(unquote(u.path)).parts and bool(key))
    request=Request(url,headers={'AccessKey':key},method='GET')
    # Exactly one bounded GET; no automatic redirect or replay.
    with (opener or build_opener(NoRedirect)).open(request,timeout=30) as response:
        require(response.status==200)
        length=response.headers.get('Content-Length')
        if length is not None:require(length.isdigit() and int(length)<=limit)
        parts=[];total=0
        while True:
            data=response.read(min(65536,limit+1-total))
            if not data:break
            total+=len(data);require(total<=limit);parts.append(data)
    return b''.join(parts)

def inspect(policy,bundle,e,observed,now):
    gate(e,observed)
    pins=TrustPins(e['REVIEWED_PRIVATE_POLICY_SHA256'],e['REVIEWED_PRIVATE_BUNDLE_SHA256'],e['REVIEWED_BOOTSTRAP_SHA'])
    verify(policy,bundle,pins,observed,datetime.fromtimestamp(now,timezone.utc))
    p=json.loads(policy,object_pairs_hook=unique)
    require(p['expires_at_utc']==e.get('REQUESTED_EXPIRY'))
    with gzip.GzipFile(fileobj=io.BytesIO(bundle)) as z:expanded=z.read(MAX_EXPANDED_BYTES+1)
    require(len(expanded)<=MAX_EXPANDED_BYTES);members={}
    with tarfile.open(fileobj=io.BytesIO(expanded),mode='r|') as archive:
        for entry in archive:
            require(entry.isfile() and entry.name not in members)
            data=archive.extractfile(entry).read(entry.size+1);require(len(data)==entry.size);members[entry.name]=data
    raw=members.get('execution-contract.json',b'')
    require(len(raw)<=65536 and digest(raw)==e['REVIEWED_PRIVATE_CONTRACT_SHA256'])
    c=json.loads(raw,object_pairs_hook=unique)
    require(type(c) is dict and set(c)=={'schema_version','entrypoint','prepare_arguments','execute_arguments','environment','bindings','data_directory_name'})
    require(type(c['schema_version']) is int and c['schema_version']==1)
    require(type(c['entrypoint']) is str and re.fullmatch(r'[A-Za-z0-9_-]+\.py',c['entrypoint']) and c['entrypoint'] in members)
    for field in ('prepare_arguments','execute_arguments'):
        a=c[field];require(type(a) is list and 1<=len(a)<=8 and all(type(s) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',s) for s in a))
    require(type(c['data_directory_name']) is str and re.fullmatch('[A-Za-z0-9_-]{1,128}',c['data_directory_name']))
    require(type(c['environment']) is dict and type(c['bindings']) is dict)
    require(not set(c['environment'])&set(c['bindings']))
    for k in set(c['environment'])|set(c['bindings']):
        require(type(k) is str and re.fullmatch('[A-Z][A-Z0-9_]{0,127}',k))
        require(not k.startswith(('PYTHON','LD_','DYLD_','BASH','GITHUB','RUNNER','INPUT_')) and k not in {'PATH','HOME','ENV','SHELLOPTS','IFS','CDPATH','TMPDIR'})
    require(all(type(v) is str and len(v)<=4096 and '\x00' not in v for v in c['environment'].values()))
    require(not any(re.search(r'(?:^|_)(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)(?:_|$)',k) for k in c['environment']))
    valid={'storage_key','openai_key','openrouter_key','data_dir','start_utc','end_utc','deadline_epoch'}
    require(set(c['bindings'].values())<=valid)
    require(c['bindings'].get('OPENAI_API_KEY')=='openai_key' and c['bindings'].get('OPENROUTER_API_KEY')=='openrouter_key')
    require(all(v!='openai_key' or k=='OPENAI_API_KEY' for k,v in c['bindings'].items()))
    require(all(v!='openrouter_key' or k=='OPENROUTER_API_KEY' for k,v in c['bindings'].items()))
    require(not {'OPENAI_API_KEY','OPENROUTER_API_KEY'}&set(c['environment']))
    return p,c,members

def stage(root,e,observed,now=None,fetcher=fetch):
    now=time.time() if now is None else now;gate(e,observed)
    require(not e.get('OPENAI_API_KEY') and not e.get('OPENROUTER_API_KEY'))
    policy=fetcher(e['PRIVATE_POLICY_URL'],e['PRIVATE_STORAGE_ACCESS_KEY'],MAX_POLICY_BYTES)
    bundle=fetcher(e['PRIVATE_BUNDLE_URL'],e['PRIVATE_STORAGE_ACCESS_KEY'],MAX_BUNDLE_BYTES)
    p,c,members=inspect(policy,bundle,e,observed,now)
    root=pathlib.Path(root).absolute();require(root.parent.resolve(strict=True)==root.parent and not root.exists() and not root.is_symlink())
    for name in members:
        require(all('/'.join(pathlib.PurePosixPath(name).parts[:i]) not in members for i in range(1,len(pathlib.PurePosixPath(name).parts))))
    os.mkdir(root,0o700);source=root/'source';os.mkdir(source,0o700)
    new_file(root/'policy.json',policy);new_file(root/'bundle.tar.gz',bundle)
    for name,data in members.items():
        path=source/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);new_file(path,data);os.chmod(path,0o400)
    for path in sorted(source.rglob('*'),reverse=True):
        if path.is_dir():os.chmod(path,0o500)
    os.chmod(source,0o500)
    new_file(root/'verified',canonical({'policy':digest(policy),'bundle':digest(bundle),'revision':observed}))
    revalidate(root,e,observed,now)
    return {'state':'verified','provider_credentials_loaded':False}

def revalidate(root,e,observed,now):
    root=pathlib.Path(root).absolute();require(not root.is_symlink() and root.resolve(strict=True)==root)
    p,c,members=inspect(read_file(root/'policy.json',MAX_POLICY_BYTES),read_file(root/'bundle.tar.gz',MAX_BUNDLE_BYTES),e,observed,now)
    require(json.loads(read_file(root/'verified',4096))=={'policy':e['REVIEWED_PRIVATE_POLICY_SHA256'],'bundle':e['REVIEWED_PRIVATE_BUNDLE_SHA256'],'revision':observed})
    source=root/'source';require(not source.is_symlink() and source.resolve(strict=True)==source)
    directories={str(parent) for name in members for parent in pathlib.PurePosixPath(name).parents if str(parent)!='.'}
    for path in source.rglob('*'):
        require(not path.is_symlink());rel=str(path.relative_to(source))
        require(rel in directories if path.is_dir() else rel in members)
    for name,data in members.items():
        path=source/name;require(path.parent.resolve(strict=True)==path.parent)
        require(read_file(path,len(data))==data)
    return p,c

def child_environment(root,e,p,c,phase):
    require(phase in ('prepare','execute'))
    env={'LANG':'C.UTF-8',**c['environment']}
    if e.get('RUNNER_TRACKING_ID'):env['RUNNER_TRACKING_ID']=e['RUNNER_TRACKING_ID']
    values={'storage_key':e['PRIVATE_STORAGE_ACCESS_KEY'],'data_dir':str(root/'evidence'/c['data_directory_name']),
        'start_utc':p['not_before_utc'],'end_utc':p['expires_at_utc'],
        'deadline_epoch':str(datetime.fromisoformat(p['expires_at_utc'].replace('Z','+00:00')).timestamp())}
    if phase=='execute':
        require(bool(e.get('OPENAI_API_KEY')) and bool(e.get('OPENROUTER_API_KEY')))
        values.update(openai_key=e['OPENAI_API_KEY'],openrouter_key=e['OPENROUTER_API_KEY'])
    for dest,binding in c['bindings'].items():
        if binding in ('openai_key','openrouter_key') and phase=='prepare':continue
        env[dest]=values[binding]
    return env

LAUNCHER='import runpy,sys; root,entry=sys.argv[1:3]; sys.path.insert(0,root); sys.argv=[entry]+sys.argv[3:]; runpy.run_path(root+"/"+entry,run_name="__main__")'
def limits():
    # Linux hosted runner: don't leave a child alive if its supervisor dies.
    require(ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGKILL,0,0,0)==0)
    if os.getppid()==1:os.kill(os.getpid(),signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024*1024,64*1024*1024))

def process(argv,cwd,env,log,timeout):
    with open(log,'xb') as out:
        os.chmod(log,0o600)
        child=subprocess.Popen(argv,cwd=cwd,env=env,shell=False,stdin=subprocess.DEVNULL,
            stdout=out,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=limits)
        try:return child.wait(timeout=timeout)
        except BaseException:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                child.wait()
            raise

def run_phase(root,e,observed,phase,clock=time.time,runner=process):
    require(phase in ('prepare','execute'));root=pathlib.Path(root).absolute()
    gate(e,observed)
    if phase=='prepare':require(not e.get('OPENAI_API_KEY') and not e.get('OPENROUTER_API_KEY'))
    lock=os.open(root/'bootstrap.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        p,c=revalidate(root,e,observed,clock())
        if phase=='execute':require(read_file(root/'prepare-done',4096)==canonical({'bundle':e['REVIEWED_PRIVATE_BUNDLE_SHA256'],'revision':observed}))
        new_file(root/(phase+'-started'),canonical({'at':clock(),'bundle':e['REVIEWED_PRIVATE_BUNDLE_SHA256']}))
        # Repeat immutable authority checks immediately before credential binding.
        p,c=revalidate(root,e,observed,clock())
        end=datetime.fromisoformat(p['expires_at_utc'].replace('Z','+00:00')).timestamp();timeout=end-clock();require(0<timeout<=7200)
        env=child_environment(root,e,p,c,phase)
        work=root/'work';work.mkdir(mode=0o700,exist_ok=True)
        (root/'evidence').mkdir(mode=0o700,exist_ok=True)
        argv=[sys.executable,'-I','-S','-B','-c',LAUNCHER,str(root/'source'),c['entrypoint'],*c[phase+'_arguments']]
        timeout=end-clock();require(0<timeout<=7200)
        status=runner(argv,work,env,root/(phase+'.private.log'),timeout)
        require(status==0)
        revalidate(root,e,observed,clock())
        new_file(root/(phase+'-done'),canonical({'bundle':e['REVIEWED_PRIVATE_BUNDLE_SHA256'],'revision':observed}))
        return {'state':phase+'-complete'}
    finally:os.close(lock)

def main():
    os.umask(0o077);parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['verify','prepare','execute']);parser.add_argument('--root',required=True);parser.add_argument('--observed-revision',required=True);a=parser.parse_args()
    try:
        result=stage(a.root,os.environ,a.observed_revision) if a.phase=='verify' else run_phase(a.root,os.environ,a.observed_revision,a.phase)
        print(json.dumps(result),flush=True);return 0
    except BaseException:
        print('{"state":"blocked","instruction":"Inspect private evidence; do not retry execution."}',flush=True);return 1
if __name__=='__main__':sys.exit(main())
