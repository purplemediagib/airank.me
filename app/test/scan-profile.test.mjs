import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {validateProfile,confirmedPrompts,profileEvidence,buildScanReport,scoreBand} from '../src/common/scan-profile.mjs';
const input={domain:'https://www.purpleplus.ai/fi',brand_name:'Purple+',aliases:['Purpleplus','Purple Plus'],category_fi:'tekoälypohjainen markkinointialusta sosiaaliseen mediaan, mainontaan, hakukoneoptimointiin ja sähköpostimarkkinointiin'};
const profile={...validateProfile(input),providers:['openai','claude'],prompt_count:3};
test('confirmed identity, canonical domain and alias matches survive punctuation and do not use the website title',()=>{
 assert.equal(profile.domain,'purpleplus.ai');assert.equal(profile.brand_name,'Purple+');
 for(const text of ['Vertaa Purple+ ja muita.','PURPLEPLUS toimii.','Purple Plus on vaihtoehto.'])assert.equal(profileEvidence(text,profile).mentioned,true);
 assert.equal(profileEvidence('Purpleplusify on yritys',profile).mentioned,false);
 assert.equal(profileEvidence('AI Marketing for Social, Ads, SEO & Email',profile).mentioned,false);
 assert.equal(profileEvidence('Purple+ Purpleplus',profile).matched_aliases.length,2);
 assert.equal(profileEvidence('1. Purple+',profile).recommended,false);
});
test('owned citations are separate from mentions and reject lookalike hosts',()=>{
 assert.deepEqual(profileEvidence('Muu yritys',profile,[{url:'https://docs.purpleplus.ai/test'}]),{mentioned:false,recommended:false,ownCitation:true,matched_aliases:[]});
 for(const u of ['https://purpleplus.ai.evil.com','https://notpurpleplus.ai','javascript:alert(1)'])assert.equal(profileEvidence('',profile,[{url:u}]).ownCitation,false);
});
test('profile validation blocks missing fields, brand leakage and unsupported markets',()=>{
 for(const extra of [{brand_name:''},{category_fi:'Purple+ marketing'},{category_fi:'Purpleplus AI alusta'},{category_fi:'https://other.com'},{aliases:'alias'},{aliases:['a']},{market:'RU'},{language:'xx'},{category_fi:'x'.repeat(241)}])assert.throws(()=>validateProfile({...input,...extra}));
 assert.throws(()=>validateProfile(null));
});
test('preview and execution use identical neutral Finnish questions with no Finnish-company restriction',()=>{
 const first=confirmedPrompts(profile,3);assert.deepEqual(first,confirmedPrompts(JSON.parse(JSON.stringify(profile)),3));assert.equal(first.length,3);
 for(const q of first){assert.ok(q.includes(profile.category_fi));assert.ok(q.includes('Suomessa'));assert.ok(!q.includes('suomalaiset yritykset'));assert.ok(!q.includes('Purple'));}
});
const obs=(provider,mention,status='success',cited=0)=>({provider,brand_mentioned:mention,provider_status:status,own_domain_cited:cited});
test('4 of 6 is 6.7, counts answers once and excludes citations/recommendations from score',()=>{
 const observations=[obs('openai',1),obs('openai',1),obs('openai',0, 'success',1),obs('claude',1),obs('claude',1),obs('claude',0)];
 const r=buildScanReport({profile,observations,promptCount:3,status:'completed'});
 assert.equal(r.score.value,6.7);assert.equal(r.score.state,'complete');assert.equal(r.score.band,'moderate');assert.equal(r.metrics.openai.owned_domain_citations,1);assert.equal(r.metrics.openai.recommended,null);
});
test('failed, missing and ungrounded answers produce partial coverage, never false zero',()=>{
 const observations=[obs('openai',1),obs('openai',0,'no_grounding'),obs('claude',0,'failed')];
 const r=buildScanReport({profile,observations,promptCount:3,status:'completed'});
 assert.equal(r.score.value,10);assert.equal(r.score.state,'partial');assert.equal(r.score.valid_answers,1);assert.equal(r.score.expected_answers,6);assert.equal(r.metrics.claude.score,null);assert.equal(r.metrics.openai.missing,1);
 const unavailable=buildScanReport({profile,observations:[obs('openai',0,'failed')],promptCount:3,status:'no_measurements'});assert.equal(unavailable.score.value,null);assert.equal(unavailable.score.state,'unavailable');
 const zero=buildScanReport({profile,observations:[obs('openai',0)],promptCount:3,status:'completed'});assert.equal(zero.score.value,0);
});
test('pending and legacy scans do not acquire a final score; stored providers survive env changes',()=>{
 const observations=[obs('openai',1)];
 assert.equal(buildScanReport({profile,observations,promptCount:3,status:'processing'}).score.value,null);
 const legacy=buildScanReport({profile:null,observations,promptCount:3,status:'completed'});assert.equal(legacy.score.state,'legacy');assert.equal(legacy.score.value,null);
 const frozen=buildScanReport({profile,observations,promptCount:3,status:'completed',legacyProviders:['gemini']});assert.deepEqual(Object.keys(frozen.metrics),['openai','claude']);
});
test('score colour boundaries cover fractional scores without gaps',()=>{
 assert.equal(scoreBand(null),null);for(const [s,b] of [[0,'low'],[4.9,'low'],[5,'limited'],[5.9,'limited'],[6,'moderate'],[8.9,'moderate'],[9,'high'],[10,'high']])assert.equal(scoreBand(s),b);
});
test('additive migration is repeatable and preserves existing free scans and evidence',()=>{
 const db=new DatabaseSync(':memory:');for(const sql of migrations)db.exec(sql);
 db.prepare('INSERT INTO scan_jobs (id,domain,brand_name,status,requested_at) VALUES (?,?,?,?,?)').run('old','purpleplus.ai','Old title','completed',1);
 for(const sql of migrations)db.exec(sql);
 assert.equal(db.prepare('SELECT brand_name FROM scan_jobs WHERE id=?').get('old').brand_name,'Old title');
 db.prepare('INSERT INTO scan_profiles VALUES (?,?,?)').run('old',JSON.stringify(profile),2);
 assert.equal(JSON.parse(db.prepare('SELECT profile_json FROM scan_profiles').get().profile_json).brand_name,'Purple+');db.close();
});
