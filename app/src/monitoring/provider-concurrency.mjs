export function providerConcurrency(env=process.env){
 const defaults={deepseek:2,kimi:3,default:6};
 if(env.PROVIDER_CONCURRENCY_JSON===undefined)return defaults;
 let values;try{values=JSON.parse(env.PROVIDER_CONCURRENCY_JSON);}catch{throw Error('PROVIDER_CONCURRENCY_JSON must be a JSON object of integer limits from 1 to 8');}
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.entries(values).some(([key,value])=>
  !/^[a-z][a-z0-9_]{0,39}$/.test(key)||!Number.isSafeInteger(value)||value<1||value>8))
  throw Error('PROVIDER_CONCURRENCY_JSON must be a JSON object of integer limits from 1 to 8');
 return {...defaults,...values};
}
