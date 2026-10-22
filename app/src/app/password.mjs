import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive = promisify(scrypt);
const options = {N:32768,r:8,p:3,maxmem:64*1024*1024};
let active = 0;
async function boundedDerive(password,salt) {
  // Do not queue unbounded password work on a small external container.
  if (active >= 2) throw Object.assign(new Error('AUTH_BUSY'),{status:503,code:'AUTH_BUSY'});
  active++;
  try { return await derive(password,salt,64,options); } finally { active--; }
}
export function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value) <= 256;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await boundedDerive(password,salt);
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password,encoded) {
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const key = await boundedDerive(password,match[1]);
  return timingSafeEqual(key,Buffer.from(match[2],'hex'));
}
// Unknown accounts perform the same password work as known accounts.
export const dummyHash = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
