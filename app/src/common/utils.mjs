import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const now = () => Date.now();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = text => createHash('sha256').update(String(text)).digest('hex');
export const uuid = () => randomUUID();
export function hmac(value, secret) { return createHmac('sha256', secret).update(value).digest('hex'); }
export function eqString(a,b) {const x=Buffer.from(String(a)), y=Buffer.from(String(b));return x.length === y.length && timingSafeEqual(x,y);}
export function toHostname(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid website');
  let s = input.trim();
  if (!s) throw new Error('Website is required');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('Unsupported website URL');
  const host = u.hostname.toLowerCase().replace(/\.$/,'');
  if (!host || !host.includes('.') || isIP(host) || host === 'localhost' || /\.(localhost|local|internal|test|invalid|example|onion)$/.test(host)) throw new Error('Only public websites are supported');
  if (host.length > 253 || host.split('.').some(s => !s || s.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s))) throw new Error('Invalid public hostname');
  return host;
}
export function isPublicIP(ip) {
  const str = String(ip || '').toLowerCase();
  if (str.startsWith('::ffff:')) return isPublicIP(str.slice(7));
  if (isIP(str) === 4) {
    const a = str.split('.').map(Number); const [x,y,z] = a;
    if (x===0 || x===10 || x===127 || x>=224 || x===169&&y===254 || x===172&&y>=16&&y<=31 || x===192&&y===168 || x===100&&y>=64&&y<=127 || x===192&&y===0&&z===0 || x===192&&y===0&&z===2 || x===192&&y===88&&z===99 || x===198&&y>=18&&y<=19 || x===198&&y===51&&z===100 || x===203&&y===0&&z===113 || x===255) return false;
    return true;
  }
  if (isIP(str) === 6) {
    if (str==='::' || str==='::1' || str.startsWith('fc') || str.startsWith('fd') || /^fe[89ab]/.test(str) || str.startsWith('2001:db8:') || str.startsWith('2001:0db8:') || str.startsWith('2001:') && str.split(':').length<3) return false;
    // Allow only global unicast; reject IPv4-compatible, link-local and special-use prefixes.
    return /^[23][0-9a-f]/.test(str);
  }
  return false;
}
export const isAllowedOrigin = (origin,allowed) => !!origin && allowed.some(s => s === origin);
export function parseCookie(cookieHeader = '') {
  const result = {};
  for (const pair of cookieHeader.split(';')) { const i=pair.indexOf('='); if (i>0) { const key=pair.slice(0,i).trim();try{result[key]=decodeURIComponent(pair.slice(i+1).trim());}catch{}} }
  return result;
}
export function textWithoutTags(html) {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim().slice(0,18000);
}
export function sanitizeText(text,limit=1000) { return String(text||'').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit); }
export function errorMessage(e) {return sanitizeText(e?.message||e,220)}
