import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewSummary, dayValue, dailySeries, matchEvidence, matchesEvidenceBrand, scopeEvidence } from '../src/analytics/summary-overview.mjs';

const now = Date.parse('2026-11-03T12:00:00Z');
const row = (id, changes = {}) => ({ id, runId: 'r1', promptId: 'p1', promptVersion: 1, text: 'Which mobile plan?', answer: 'Consider Own and Rival.',
  provider: 'OpenAI', model: 'test-model', topic: 'Mobile', tags: ['first','second'], market: 'FI', language: 'fi', measurementSurface: 'model_api',
  observedAt: now, exclusion: null, mentioned: true, ownedCitation: true, recommendation: 'recommended', position: 2,
  brandNames: ['Own','Rival'], citations: ['https://news.example/article'],
  brandOrder: { state: 'observed', targetPosition: 1, mentions: [{ brandName: 'Own' },{ brandName: 'Rival' }] },
  sentiment: { status: 'complete', score: 60, analysisVersion: 'v1' }, ...changes });
const rows = [row('a'), row('b', { provider: 'Claude', mentioned: false, ownedCitation: false, recommendation: 'not_recommended', position: null, brandNames: [], brandOrder: { state: 'observed', targetPosition: null, mentions: [] }, sentiment: { status: 'not_mentioned' } }),
  row('c', { ownedCitation: false, recommendation: 'unknown', position: 4, brandOrder: { state: 'observed', targetPosition: 2, mentions: [{brandName:'Rival'},{brandName:'Own'}] }, sentiment: { status:'complete', score:40, analysisVersion:'v2' } }),
  row('excluded', { exclusion:'failed', provider:'Claude' })];
const analytics = { selectedGroup:'g1', runs:[{id:'r1',group:'g1'},{id:'r2',group:'g2'}], evidence:rows, competitors:[{brandName:'Own'},{brandName:'Rival'}] };
const args = (changes = {}) => ({ analytics, allEvidence: rows, project:{brandName:'Own',ownedDomains:['own.example']}, filters:{from:'2026-11-03',to:'2026-11-03'}, now, ...changes });

test('overview-ui-v1 preserves all eight daily definitions, not the headline denominators', () => {
  const {ui,evidence}=buildOverviewSummary(args());
  assert.equal(ui.version,'overview-ui-v1');
  assert.deepEqual(evidence.map(e=>e.id),['a','b','c','excluded']);
  assert.deepEqual(ui.models,{all:['OpenAI','Claude'],mentioning:['OpenAI']});
  assert.deepEqual(ui.providerExclusions,{Claude:{failed:1}});
  const expected={visibility:2/3,share:0.5,sentiment:50,citations:1/3,recommendations:0.5,winRate:0.5,position:1.5,listRank:3};
  for(const [metric,value] of Object.entries(expected)) assert.deepEqual(ui.daily[metric],{firstDay:'2026-11-03',points:[{date:'2026-11-03',value,answers:4}]},metric);
  assert.equal(ui.weeklyDigest.current.visibility,66.7);
  assert.equal(ui.byBrand.Rival.total,3);
});

test('missing days and unavailable metrics remain null, measured zero stays zero', () => {
  const result=dailySeries([row('early',{observedAt:now-2*86400000,mentioned:false})],'visibility','all',now);
  assert.deepEqual(result.points.map(p=>p.value),[0,null,null]);
  assert.equal(dayValue([],'visibility'),null);
  assert.equal(dayValue([row('x',{exclusion:'failed'})],'visibility'),null);
  assert.equal(dayValue([row('x',{kind:'diagnostic'})],'visibility'),null);
  assert.equal(dayValue([row('x',{recommendation:'unknown'})],'recommendations'),null);
  assert.equal(dayValue([row('x',{brandOrder:{state:'observed',mentions:[],targetPosition:null}})],'winRate'),null);
});

test('scope uses observedAt, exact selected group, UTC dates and supported filters', () => {
  const source={...analytics,evidence:[...rows,row('outside',{observedAt:now-86400000}),row('othergroup',{runId:'r2'}),row('seconds',{observedAt:now/1000})]};
  const selected=scopeEvidence(source,{from:'2026-11-03',to:'2026-11-03',provider:'OpenAI',topic:'Mobile',tags:'["first","second"]',tagMode:'and',market:'FI',language:'fi',surface:'model_api',promptId:'p1',promptVersion:'1'});
  assert.deepEqual(selected.map(e=>e.id),['a','c','seconds']);
  assert.equal(scopeEvidence(source,{from:'2026-11-03',to:'2026-11-03',tags:'["absent"]'}).length,0);
});

test('all-setup trend union is deduplicated but headline models and drawer remain selected group', () => {
  const all=[...rows,row('other',{runId:'r2',provider:'Gemini',mentioned:false}),row('a',{mentioned:false})];
  const {ui,evidence}=buildOverviewSummary(args({allEvidence:all}));
  assert.deepEqual(ui.models.mentioning,['OpenAI']);
  assert.equal(evidence.length,4);
  assert.equal(ui.daily.visibility.points[0].answers,5);
  assert.equal(ui.daily.visibility.points[0].value,1/4);
});

test('brand drilldowns preserve exact names and brand-order precedence', () => {
  assert.equal(matchesEvidenceBrand(row('x'),'rival'),false);
  assert.equal(matchesEvidenceBrand(row('x',{brandOrder:{state:'observed',mentions:[]}}),'Rival'),false);
  assert.equal(matchesEvidenceBrand(row('x',{brandOrder:undefined}),'Rival'),true);
  assert.equal(matchesEvidenceBrand(row('x'),''),true);
});

test('full-selection search and filters match the UI predicate', () => {
  for(const query of ['CONSIDER','mobile','openai','test-model','first','Rival','news.example']) assert.equal(matchEvidence(row('a'),'all',query),true,query);
  assert.equal(matchEvidence(row('a'),'all','absent'),false);
  assert.equal(matchEvidence(row('a'),'mentioned',''),true);
  assert.equal(matchEvidence(row('a'),'recommended',''),true);
  assert.equal(matchEvidence(row('a'),'cited',''),true);
  assert.equal(matchEvidence(row('a'),'ordered',''),true);
  assert.equal(matchEvidence(row('a'),'first',''),true);
  assert.equal(matchEvidence(row('a'),'excluded',''),false);
  for(const filter of ['mentioned','recommended','cited','ordered','first']) assert.equal(matchEvidence(row('a',{exclusion:'failed'}),filter,''),false,filter);
});

test('weekly insights preserve newest-answer anchor and original raw timestamp behavior', () => {
  const old=row('old',{observedAt:now-8*86400000,mentioned:false,brandNames:['Rival'],citations:['https://old.example/a']});
  const newer=row('new',{citations:['https://new.example/a']});
  const seconds=row('seconds',{observedAt:now/1000});
  const source={...analytics,evidence:[old,newer,seconds]};
  const {ui}=buildOverviewSummary(args({analytics:source,filters:{from:'2026-10-20',to:'2026-11-03'}}));
  assert.equal(ui.total,3);
  assert.equal(ui.weeklyDigest.current.answers,1);
  assert.equal(ui.weeklyDigest.previous.answers,1);
  assert.deepEqual(ui.weeklyDigest.wins,['Which mobile plan?']);
  assert.deepEqual(ui.weeklyDigest.newDomains,['new.example']);
});

test('gap and source insights exclude owned and already-own-mentioned domains', () => {
  const gap=row('gap',{mentioned:false,citations:['https://opportunity.example/a','https://own.example/a','https://news.example/b']});
  const source={...analytics,evidence:[row('own'),gap]};
  const {ui}=buildOverviewSummary(args({analytics:source}));
  assert.equal(ui.gapPrompts[0].gaps,1);
  assert.equal(ui.gapPrompts[0].answers,2);
  assert.deepEqual(ui.sourceOpportunities,[{domain:'opportunity.example',competitorAnswers:1,competitors:['Rival']}]);
});

test('prototype-like brand and provider names are safe own data keys', () => {
  const weird=row('x',{provider:'__proto__',exclusion:'constructor',brandOrder:undefined,brandNames:['__proto__']});
  const {ui}=buildOverviewSummary(args({analytics:{...analytics,evidence:[weird],competitors:[{brandName:'__proto__'}]}}));
  assert.equal(Object.hasOwn(ui.byBrand,'__proto__'),true);
  assert.equal(ui.byBrand.__proto__.total,1);
  assert.equal(ui.providerExclusions.__proto__.constructor,1);
});
