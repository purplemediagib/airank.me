// Adapted from the user's Purple Google Connector 0.2.0 encrypted SQLite store.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

export class Store {
  constructor(dir, key) {
    if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    mkdirSync(dir, {recursive:true, mode:0o700});
    this.key = Buffer.from(key,'hex');
    this.db = new DatabaseSync(join(dir,'airank.sqlite'));
    chmodSync(join(dir,'airank.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(kind,id));`);
  }
  seal(kind,id,value) {
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
    c.setAAD(Buffer.from(JSON.stringify([kind,id])));
    const b=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
    return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');
  }
  open(kind,id,value) {
    const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));
    d.setAAD(Buffer.from(JSON.stringify([kind,id])));d.setAuthTag(b.subarray(12,28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());
  }
  set(kind,id,value,ttl=0) {
    this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(kind,id,this.seal(kind,id,value),ttl?Date.now()+ttl*1000:0);
  }
  get(kind,id) {
    const r=this.db.prepare('SELECT payload,expires FROM records WHERE kind=? AND id=?').get(kind,id);
    return !r||(r.expires&&r.expires<=Date.now())?null:this.open(kind,id,r.payload);
  }
  take(kind,id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const v=this.get(kind,id);this.del(kind,id);this.db.exec('COMMIT');return v;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  del(kind,id){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
  list(kind){return this.db.prepare('SELECT id,payload,expires FROM records WHERE kind=?').all(kind).filter(r=>!r.expires||r.expires>Date.now()).map(r=>({id:r.id,value:this.open(kind,r.id,r.payload)}));}
  cleanup(){this.db.prepare('DELETE FROM records WHERE expires>0 AND expires<=?').run(Date.now());}
  close(){this.db.close();}
}
