import {sanitizeText,toHostname} from './utils.mjs';
import {measurementContext} from './measurement-context.mjs';
export const METHODOLOGY='confirmed-fi-mentions-v2';
const invalid=(message)=>{throw Object.assign(new Error(message),{status:422,code:'PROFILE_INVALID'});};
const field=(value,min,max,name)=>{if(typeof value!=='string'||value.length>max)invalid(`${name} must be ${min}-${max} characters`);const s=sanitizeText(value,max);if(s.length<min)invalid(`${name} must be ${min}-${max} characters`);return s;};
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function containsName(text,name){return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(name.normalize('NFKC'))}(?=$|[^\\p{L}\\p{N}])`,'iu').test(String(text).normalize('NFKC'));}
export function validateProfile(body){
 if(!body||typeof body!=='object'||Array.isArray(body))invalid('A profile object is required');
 const domain=toHostname(body.domain).replace(/^www\./,'');
 const brand_name=field(body.brand_name,2,100,'brand_name');
 if(body.aliases!==undefined&&(!Array.isArray(body.aliases)||body.aliases.length>8))invalid('aliases must be an array of up to 8 brand names');
 const aliases=[...new Set((body.aliases||[]).map(a=>field(a,2,100,'alias')))];
 const category_fi=field(body.category??body.category_fi,8,240,'category');
 if(/[\n\r<>]/.test(body.category??body.category_fi)||/https?:\/\/|www\./i.test(category_fi))invalid('category must be a plain product/service category, without links');
 if([brand_name,...aliases,domain].some(n=>containsName(category_fi,n)))invalid('category_fi must not include the brand, aliases or domain');
 const context=measurementContext(body);
 return {domain,brand_name,aliases,category_fi,...context};
}
export function confirmedPrompts(profile,count=3){
 const context=measurementContext(profile);
 if(context.market!=='FI'||context.language!=='fi')throw Object.assign(Error('CONTEXT_PROMPTS_REQUIRED'),{status:422,code:'CONTEXT_PROMPTS_REQUIRED'});
 const c=profile.category_fi;
 return [
 `Mitkä palveluntarjoajat tai tuotteet sopivat Suomessa toimivalle asiakkaalle seuraavaan tarpeeseen: ${c}? Nimeä konkreettisia vaihtoehtoja.`,
 `Mitä vaihtoehtoja Suomessa toimivan asiakkaan kannattaa vertailla, kun tarve on: ${c}? Nimeä vaihtoehdot ja perustele erot.`,
 `Mitä palveluntarjoajia tai tuotteita suosittelisit Suomessa toimivalle asiakkaalle seuraavaan tarpeeseen: ${c}? Perustele valinta ja mainitse rajoitukset.`,
 `Mitkä vaihtoehdot soveltuvat parhaiten pienyritykselle Suomessa, kun tarve on: ${c}?`,
 `Mitä Suomessa saatavilla olevia vaihtoehtoja on tarpeeseen: ${c}, ja miten niiden ominaisuudet eroavat?`,
 `Mitkä Suomessa saatavilla olevat vaihtoehdot sopivat tarpeeseen: ${c}, kun painotetaan helppokäyttöisyyttä?`
 ].slice(0,Math.max(1,Math.min(6,count)));
}
export function profileEvidence(answer,profile,citations=[]){
 const matched_aliases=[profile.brand_name,...profile.aliases].filter(n=>containsName(answer,n));
 const ownCitation=citations.some(c=>{try{const h=toHostname(c.url).replace(/^www\./,'');return h===profile.domain||h.endsWith('.'+profile.domain);}catch{return false;}});
 return {mentioned:matched_aliases.length>0,recommended:false,ownCitation,matched_aliases};
}
export function scoreBand(score){return score===null?null:score>=9?'high':score>=6?'moderate':score>=5?'limited':'low';}
export function buildScanReport({profile,observations,promptCount,status,legacyProviders=[]}){
 const providers=profile?.providers||[...new Set([...legacyProviders,...observations.map(o=>o.provider)])];
 const terminal=['completed','no_measurements','failed'].includes(status);
 const metrics={};
 for(const p of providers){
  const all=observations.filter(o=>o.provider===p), eligible=all.filter(o=>o.provider_status==='success');
  const mentioned=eligible.filter(o=>Number(o.brand_mentioned)===1).length;
  const value=profile&&terminal&&eligible.length?Math.round(mentioned/eligible.length*100)/10:null;
  metrics[p]={sample_size:eligible.length,mentioned,recommended:null,owned_domain_citations:eligible.filter(o=>Number(o.own_domain_cited)===1).length,unavailable:all.filter(o=>o.provider_status!=='success').length,expected:promptCount,missing:Math.max(0,promptCount-all.length),score:value,band:scoreBand(value)};
 }
 const rows=Object.values(metrics),valid=rows.reduce((n,r)=>n+r.sample_size,0),mentions=rows.reduce((n,r)=>n+r.mentioned,0),expected=providers.length*promptCount;
 const value=profile&&terminal&&valid?Math.round(mentions/valid*100)/10:null;
 const state=!profile?'legacy':!terminal?'pending':!valid?'unavailable':valid<expected||status==='failed'?'partial':'complete';
 return {metrics,score:{value,out_of:10,band:scoreBand(value),state,mentions,valid_answers:valid,expected_answers:expected,providers_requested:providers,providers_measured:providers.filter(p=>metrics[p].sample_size>0),methodology:profile?METHODOLOGY:'legacy-unconfirmed',sample_label:'quick_check',formula:'10 * brand-mention answers / valid answers',recommendations_included:false}};
}
