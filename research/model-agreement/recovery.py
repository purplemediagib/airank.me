"""Read-only remote restore into a fresh ephemeral directory; never initializes a ledger."""
import io,json,pathlib,sqlite3,tarfile,tempfile,os
import core,storage,service
MAX_ARCHIVE=64*1024*1024
MAX_EXPANDED=256*1024*1024

def restore(root,m,remote,expected_head_sha):
    root=service.check_root(root)
    if root.exists():raise RuntimeError('Recovery target must not exist')
    if len(expected_head_sha)!=64:raise RuntimeError('Reviewed remote head hash required')
    head=remote.head()
    if not head or core.digest(core.canonical(head))!=expected_head_sha:raise RuntimeError('Reviewed head differs')
    if head.get('study_id')!=core.STUDY or head.get('protocol_sha256')!=core.protocol_hash(m):raise RuntimeError('Snapshot identity differs')
    name=head['archive']
    if name!='snapshot-'+head['sha256']+'.tar.gz':raise RuntimeError('Snapshot name differs')
    data=remote.get(name)
    if data is None or len(data)>MAX_ARCHIVE or core.digest(data)!=head['sha256']:raise RuntimeError('Snapshot hash/size invalid')
    root.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root.parent,prefix='.restore-') as td:
        stage=pathlib.Path(td)/core.STUDY;stage.mkdir(mode=0o700);seen=set();size=0
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
            for entry in tar:
                p=pathlib.PurePosixPath(entry.name)
                if p.is_absolute() or '..' in p.parts or str(p)!=entry.name or entry.name in seen:raise RuntimeError('Unsafe or duplicate archive path')
                seen.add(entry.name)
                allowed=entry.name in {'ledger.sqlite','identity.json','manifest.json','prompts.json','schedule.json'} or (len(p.parts)==2 and p.parts[0] in {'raw','manifests'} and p.suffix=='.json')
                if entry.isdir() and entry.name in {'raw','manifests'}:(stage/entry.name).mkdir(exist_ok=True);continue
                if not entry.isfile() or not allowed:raise RuntimeError('Unsafe archive entry type/name')
                size+=entry.size
                if size>MAX_EXPANDED or len(seen)>10000:raise RuntimeError('Expanded archive limit')
                content=tar.extractfile(entry).read(entry.size+1)
                if len(content)!=entry.size:raise RuntimeError('Archive length mismatch')
                core.write_once(stage/entry.name,content)
        with sqlite3.connect('file:'+str(stage/'ledger.sqlite')+'?mode=ro',uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('SQLite corrupt')
        core.atomic(stage/'remote-head.json',core.canonical(head))
        remote.verify(stage,m)
        if remote.head()!=head:raise RuntimeError('Remote head changed during restore')
        # Local same-runner exclusivity. Global GitHub concurrency/external singleton still required.
        with core.locked(stage):
            if storage.state_fingerprint(stage)!=head['state_sha256']:raise RuntimeError('Restored ledger/raw mismatch')
            os.rename(stage,root)
    return head
