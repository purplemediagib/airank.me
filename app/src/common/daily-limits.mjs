// Unlimited is explicit. Missing settings retain the existing finite defaults;
// zero retains its existing meaning (no calls), never unlimited.
export function dailyCallLimit(env,key,fallback,max){
 if(env[key]==='unlimited')return null;
 const n=Number(env[key]??fallback);
 if(!Number.isSafeInteger(n)||n<0||n>max)throw Object.assign(Error('APP_NOT_CONFIGURED'),{status:503,code:'APP_NOT_CONFIGURED'});
 return n;
}
export const providerDailyLimit=(env=process.env)=>dailyCallLimit(env,'MAX_DAILY_PROVIDER_CALLS',200,1000000);
