import {toHostname} from './utils.mjs';
/** Edge/worker boundary: never trust a browser-normalised value. */
export function normalizeWebsite(input){
 if(typeof input!=='string'||input.length>2048||/[\u0000-\u0020\u007f\\]/.test(input.trim()))throw Error('INVALID_WEBSITE');
 let value=input.trim();
 if(value.startsWith('//'))value='https:'+value;
 if(/^[a-z][a-z0-9+.-]*:/i.test(value)&&!/^https?:\/\//i.test(value))throw Error('INVALID_WEBSITE');
 if(!/^https?:\/\//i.test(value))value='https://'+value;
 const u=new URL(value),host=toHostname(value);
 if(u.username||u.password||u.port||/^[0-9.]+$/.test(host))throw Error('INVALID_WEBSITE');
 const domain=host.replace(/^www\./,'');
 // Identity is the domain; do not forward sensitive query strings, fragments or arbitrary paths.
 return {website:`${u.protocol}//${host}/`,domain};
}
