import {requestJson} from './common.mjs';
import {measurementContext} from '../common/measurement-context.mjs';

let cached=null,pending=null;
const root='https://api.dataforseo.com/v3/serp/google';
function results(j){
 const task=j.tasks?.[0];
 if(task?.status_code!==20000||!Array.isArray(task.result))throw Error('DataForSEO locale catalogue unavailable');
 return task.result;
}
export async function localeCatalog(headers,timeoutMs){
 if(cached&&cached.expires>Date.now())return cached.value;
 if(!pending)pending=Promise.all(['locations','languages'].map(path=>
  requestJson(`${root}/${path}`,{headers,timeoutMs,redactErrors:true}).then(results)
 )).then(([locations,languages])=>{
  const value={locations,languages};cached={value,expires:Date.now()+86400000};return value;
 }).finally(()=>{pending=null;});
 return pending;
}
export function selectSerpContext(context,catalog){
 const {market,language}=measurementContext(context);
 const location=catalog.locations.find(x=>x.country_iso_code===market&&x.location_type==='Country');
 const supportedLanguage=catalog.languages.find(x=>x.language_code===language);
 if(!location||!supportedLanguage)return null;
 return {location_code:location.location_code,location_name:location.location_name,language_code:language,market};
}
