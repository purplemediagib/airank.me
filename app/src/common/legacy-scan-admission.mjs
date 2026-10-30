import {randomToken,hashToken,uuid} from './utils.mjs';
import {scanLimitError} from './scan-limits.mjs';
import {one,exec,transaction} from '../monitoring/shared.mjs';

// Called only after legacy request/profile/CAPTCHA validation. A write transaction
// serializes both quota reads and all inserts with public-check admission, which
// uses the same rate_events table. No network work takes place under the lock.
export async function admitLegacyScan({db,snapshot,fingerprint,session=null,env=process.env,now=Date.now}){
 return transaction(db,async tx=>{
  const time=now(),domain=snapshot.domain;
  const recent=await one(tx,'SELECT COUNT(*) n FROM rate_events WHERE fingerprint=? AND requested_at>?',[fingerprint,time-86400000]);
  const weekly=await one(tx,'SELECT COUNT(*) n FROM rate_events WHERE domain=? AND requested_at>?',[domain,time-7*86400000]);
  const error=scanLimitError({recentCount:recent?.n,weeklyCount:weekly?.n,authenticated:!!session},env);
  if(error)throw Object.assign(Error(error.error),{status:429,code:error.code});
  const id=uuid(),guestToken=session?null:randomToken();
  await exec(tx,'INSERT INTO scan_jobs (id,domain,brand_name,owner_id,guest_token_hash,status,requested_at) VALUES (?,?,?,?,?,?,?)',[id,domain,snapshot.brand_name,session?.user_id||null,guestToken?hashToken(guestToken):null,'queued',time]);
  await exec(tx,'INSERT INTO scan_profiles (scan_id,profile_json,created_at) VALUES (?,?,?)',[id,JSON.stringify(snapshot),time]);
  await exec(tx,'INSERT INTO rate_events (id,fingerprint,domain,requested_at) VALUES (?,?,?,?)',[uuid(),fingerprint,domain,time]);
  return {id,guestToken};
 });
}
