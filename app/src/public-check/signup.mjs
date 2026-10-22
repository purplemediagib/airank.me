import {one,exec} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
async function enabled(db,env){
 if(env.PUBLIC_CHECK_ENABLED!=='true')return false;
 return (await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;
}
export async function recordNewGoogleSignup(db,env,sessionHash,newUser){
 if(newUser&&await enabled(db,env))await exec(db,'INSERT INTO public_check_signup_events VALUES (?,1)',[sessionHash]);
}
export async function claimNewGoogleSignup(db,env,sessionHash){
 if(!sessionHash||!await enabled(db,env))return false;
 return Boolean((await exec(db,'DELETE FROM public_check_signup_events WHERE session_hash=? AND pending=1 RETURNING session_hash',[sessionHash])).rows.length);
}
