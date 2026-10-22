import {aggregateSentiment,brandKey} from '../sentiment/core.mjs';
import { containsName } from '../common/scan-profile.mjs';
import { firstMentionOrder, aggregateBrandOrder } from './brand-order.mjs';
import {reconcileObservation,collectionSurface,methodFor,metricsFor,legacyMetricVersion} from '../common/observations.mjs';
export const extractionVersion = 'context-aware-literal-fi-en-recommendations-v2';
export const metricVersion = legacyMetricVersion;
export const sourceUrls=e=>(e.collection?.sourceReferences?e.collection.sourceReferences.filter(s=>s.kind!=='retrieval').map(s=>s.url):e.citations||[]).map(c=>typeof c==='string'?c:c.url);
const names = identity => [identity.brandName, ...(identity.aliases || [])].filter(Boolean);
const mentions = (text, identity) => names(identity).some(n => containsName(text, n));
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
const host = value => { try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); } catch { return ''; } };

// Conservative, deterministic extraction. Spans are verbatim source sentences/lines.
// No classifier model, extra provider calls, or reinterpretation of legacy flags.
export function extract(e, snapshot) {
  e=reconcileObservation(e,snapshot);
  const answer = String(e.answer || ''), identity = snapshot.identity;
  const eligible = e.status === 'success' && answer.trim().length > 0 && snapshot.kind === 'neutral';
  const citations = [...new Set((e.citations || []).map(c => safeUrl(typeof c === 'string' ? c : c.url)).filter(Boolean))];
  const own = citations.some(u => (identity.ownedDomains || []).some(d => {
    const h = host(u), owned = host(d);
    return owned && (h === owned || h.endsWith(`.${owned}`));
  }));
  let recommendation = 'unknown', position = null;
  const spans = [], decisions = [];
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n/)) {
    if (!mentions(sentence, identity)) continue;
    const escaped = names(identity).map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
    const negative = new RegExp(`(?:do not recommend|don't recommend|en suosittele|emme suosittele|ei suositella)\\s+(?:${escaped})(?=$|[^\\p{L}\\p{N}])|(?:${escaped})\\s+(?:is not recommended|ei ole suositeltava)`,'iu').test(sentence.normalize('NFKC'));
    const positive = new RegExp(`(?:I recommend|we recommend|recommended:|recommendation:|suosittelen|suosittelemme|suositus:)\\s+(?:${escaped})(?=$|[^\\p{L}\\p{N}])`,'iu').test(sentence.normalize('NFKC'));
    // Qualifiers and warnings make a positive match ambiguous rather than an endorsement.
    const ambiguous=/[?"“”]|\b(?:but|however|unless|if|warning|not)\b|mutta|kuitenkin|varoitus|jos /iu.test(sentence);
    if (negative || (positive && !ambiguous)) { decisions.push(negative ? 'not_recommended' : 'recommended'); spans.push(sentence); }
  }
  if (decisions.length && new Set(decisions).size === 1) recommendation = decisions[0];
  // Position requires an explicitly recommended numbered list, unique ranks,
  // a single occurrence of the tracked brand, and no tie/ambiguity warning.
  const lines = answer.split('\n'), numbered = lines.map((line, i) => ({line, i, m:line.match(/^\s*(\d+)[.)]\s+(.+)$/)})).filter(x => x.m);
  const hits = numbered.filter(x => mentions(x.m[2], identity));
  const heading = numbered.length ? lines.slice(Math.max(0, numbered[0].i - 2), numbered[0].i).join(' ') : '';
  if (numbered.length >= 2 && hits.length === 1 && /^(?:[#* ]*)(?:recommendations|recommended options|suositukset|suositellut vaihtoehdot)[:* ]*$/iu.test(heading) &&
      !/\b(?:tie|tied|equal|warning|avoid|not recommended)\b|tasapeli|tasavertai|ei paremmuusjärjest|varoitus|vältä|ei suosit/iu.test(answer) &&
      numbered.every((x, i) => Number(x.m[1]) === i + 1) && recommendation !== 'not_recommended' && new Set(decisions).size < 2) {
    position = Number(hits[0].m[1]); recommendation = 'recommended';
    spans.push(heading, hits[0].line);
  }
  const cohort = snapshot.cohort?.brands;
  if(!['fi','en'].includes(snapshot.language??'fi')){recommendation='unknown';position=null;spans.length=0;}
  const cohortMentions = Array.isArray(cohort) ? cohort.filter(b => mentions(answer,b)).length : null;
  return {
    ...e, sentiment:e.brandSentiments?.[brandKey(identity)]||e.sentiment, answer, citations, mentioned: eligible && mentions(answer, identity), ownedCitation: eligible && own,
    citationEligible:eligible&&(e.collection?.citationObservation??e.observation?.citationObservation)!=='unavailable',
    measurementSurface:collectionSurface(e,snapshot),collectionMethod:methodFor(snapshot,e),metricVersion:metricsFor(snapshot,e),
    recommendation: eligible ? recommendation : 'unknown', recommendationSpans: eligible ? [...new Set(spans)] : [],
    position: eligible ? position : null,
    brandOrder: firstMentionOrder(answer, snapshot, eligible),
    exclusion: eligible ? null : snapshot.kind !== 'neutral' ? 'diagnostic' : e.status === 'success' ? 'empty_answer' : e.status,
    cohortMentions, cohortAvailable: Array.isArray(cohort) && cohort.some(b => b.brandName === identity.brandName),
  };
}

const percent = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
export function aggregate(rows, expected) {
   const contexts=new Set(rows.map(e=>JSON.stringify([e.measurementSurface||'model_api',e.collectionMethod||'citation-required-v1',e.metricVersion||metricVersion])));
   if(contexts.size>1)return {...aggregate([],expected),state:'incompatible',reason:'mixed_measurement_contexts',measurementContexts:[...contexts].map(c=>JSON.parse(c))};
  const valid = rows.filter(e => !e.exclusion), eligible = valid.length;
  const mentions = valid.filter(e => e.mentioned).length;
  const ownedCitations = valid.filter(e => e.ownedCitation).length;
  const citationAnswers=valid.filter(e=>e.citationEligible!==false).length;
  const classified = valid.filter(e => e.recommendation !== 'unknown').length;
  const recommended = valid.filter(e => e.recommendation === 'recommended').length;
  // Only explicit positive integer ranks extracted from stored numbered lists
  // contribute; positions is the denominator for the mean rank.
  const ranked = valid.filter(e => Number.isSafeInteger(e.position) && e.position > 0);
  const cohortMentions = valid.reduce((n,e) => n + (e.cohortMentions || 0), 0);
   return {metricVersion:rows[0]?.metricVersion||metricVersion,measurementSurface:rows[0]?.measurementSurface||null,collectionMethod:rows[0]?.collectionMethod||null,
     sentiment:aggregateSentiment(valid),brandOrder:aggregateBrandOrder(valid),eligible, expected, mentions, ownedCitations, classified, recommended, positions:ranked.length,
    visibility:percent(mentions,eligible), score:eligible ? Math.round(mentions / eligible * 100) / 10 : null,
    citationAnswers,citationRate:percent(ownedCitations,citationAnswers), recommendationRate:percent(recommended,classified),
    cohortShare:valid.length && valid.every(e=>e.cohortAvailable) ? percent(mentions,cohortMentions) : null, cohortMentions,
    meanPosition:ranked.length ? Math.round(ranked.reduce((n,e)=>n+e.position,0)/ranked.length*10)/10 : null,
    state:!eligible ? 'unavailable' : eligible < expected ? 'partial' : 'complete'};
}
