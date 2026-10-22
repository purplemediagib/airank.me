import {observationContextKey} from '../common/observations.mjs';
export const sourceVersion = 'observed-source-evidence-v1';
export const apiSourceVersion = 'observed-api-occurrence-evidence-v2';
const kinds = ['citation', 'source_reference', 'retrieval', 'answer_link'];
const safeUrl = value => {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
};
const host = url => new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const owns = (domain, domains = []) => domains.some(d => {
  const u = safeUrl(d.includes('://') ? d : `https://${d}`);
  return u && (domain === host(u) || domain.endsWith(`.${host(u)}`));
});

/** Literal answer URLs, not inferred citations. Originals remain unchanged. */
export function answerUrls(answer) {
  const urls = new Map();
  for (const match of String(answer || '').matchAll(/https?:\/\/[^\s<>"`\u0000-\u001f]+/giu)) {
    let text = match[0].replace(/[.,;!]+$/, '');
    while (text.endsWith(')') && (text.match(/\)/g) || []).length > (text.match(/\(/g) || []).length) text = text.slice(0, -1);
    for (const [open, close] of [['[',']'],['{','}']]) {
      while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0,-1);
    }
    const url = safeUrl(text);
    if (url) urls.set(url, (urls.get(url) || 0) + 1);
  }
  return [...urls].map(([url, occurrences]) => ({url, occurrences, kind:'answer_link', provenance:'literal_answer_url'}));
}

/** Read-time, frozen-snapshot attribution; separate source kinds are never added as citation votes. */
export function sourceAnalytics(entries) {
  const contexts=new Map();
  for(const entry of entries)for(const row of entry.rows){
    const key=observationContextKey(row,entry.snapshot),part=contexts.get(key)||[];
    part.push({...entry,rows:[row]});contexts.set(key,part);
  }
  if(contexts.size>1)return {version:apiSourceVersion,state:'incompatible',reason:'mixed_measurement_contexts',
    eligibleAnswers:null,coverage:[],items:[],groups:[...contexts].map(([context,part])=>({context:JSON.parse(context),...sourceAnalytics(part)}))};
  const items = new Map(), valid = new Set();
  const observed = new Map(kinds.map(k => [k, new Set()]));
  const answersByKind = new Map(kinds.map(k => [k, new Set()]));
  for (const entry of entries) {
    for (const row of entry.rows) {
      if (row.exclusion) continue;
      valid.add(row.id);
      const references = Array.isArray(row.collection?.sourceReferences) ? row.collection.sourceReferences : [];
      // API occurrence arrays retain repeated annotations, unlike legacy URL
      // deduplication. Preserve spans in evidence, report an exact per-URL count.
      const occurrenceCounts=new Map();
      for(const ref of row.observation?.citationOccurrences||[]){
        const url=safeUrl(ref.url);if(url)occurrenceCounts.set(url,(occurrenceCounts.get(url)||0)+1);
      }
      const apiReferences=[...occurrenceCounts].map(([url,occurrences])=>({url,occurrences,kind:'citation',provenance:'provider_annotation_occurrences'}));
      // Deduplicated citations can coexist with richer passage associations.
      const explicit = (row.citations || []).map(c => ({url:typeof c === 'string' ? c : c.url, kind:'citation', provenance:'stored_citation'}));
      const richerCitations = new Set([...references,...apiReferences].filter(r => r.kind === 'citation').map(r => safeUrl(r.url)));
      const all = [...references,...apiReferences, ...explicit.filter(r => !richerCitations.has(safeUrl(r.url))), ...answerUrls(row.answer)];
      observed.get('answer_link').add(row.id);
      if (row.citationEligible !== false || all.some(r => r.kind === 'citation' && safeUrl(r.url))) observed.get('citation').add(row.id);
      if (['observed','not_observed'].includes(row.collection?.retrievalObservation) || references.some(r => r.kind === 'retrieval')) observed.get('retrieval').add(row.id);
      const perAnswer = new Map();
      for (const ref of all) {
        const url = safeUrl(ref.url);
        if (!url || !kinds.includes(ref.kind)) continue;
        const key = JSON.stringify([ref.kind, url]);
        const item = perAnswer.get(key) || {url, kind:ref.kind, counts:[], provenances:new Set()};
        if (Number.isSafeInteger(ref.occurrences) && ref.occurrences > 0) item.counts.push(ref.occurrences);
        if (typeof ref.provenance === 'string') item.provenances.add(ref.provenance);
        perAnswer.set(key, item);
      }
      for (const [key, ref] of perAnswer) {
        const domain = host(ref.url), identity = entry.snapshot.identity;
        const competitors = (entry.snapshot.cohort?.brands || []).filter(b => b.brandName !== identity.brandName);
        const category = owns(domain, identity.ownedDomains) ? 'owned' : competitors.some(b => owns(domain, b.ownedDomains)) ? 'competitor' : 'other';
        const item = items.get(key) || {url:ref.url, domain, kind:ref.kind, evidence:new Set(), categories:new Set(), providers:new Set(), surfaces:new Set(), provenances:new Set(), counts:new Map()};
        item.evidence.add(row.id); item.categories.add(category); item.providers.add(row.provider);
        item.surfaces.add(row.measurementSurface || 'model_api');
        ref.provenances.forEach(p => item.provenances.add(p));
        // Vendor passage associations may repeat global per-URL counts. Max per
        // answer is reported, never a sum masquerading as verified retrievals.
        if (ref.counts.length) item.counts.set(row.id, ref.counts.reduce((max,n) => Math.max(max,n), item.counts.get(row.id) || 0));
        items.set(key, item); answersByKind.get(ref.kind).add(row.id);
      }
    }
  }
  const rows = [...items.values()].map(item => ({
    url:item.url, domain:item.domain, kind:item.kind, category:item.categories.size === 1 ? [...item.categories][0] : 'mixed',
    answers:item.evidence.size, evidenceIds:[...item.evidence].sort(),
    reportedOccurrences:item.counts.size ? [...item.counts.values()].reduce((a,b) => a+b, 0) : null,
    occurrenceAnswers:item.counts.size, providers:[...item.providers].sort(), surfaces:[...item.surfaces].sort(), provenances:[...item.provenances].sort(),
  })).sort((a,b) => b.answers-a.answers || a.url.localeCompare(b.url) || a.kind.localeCompare(b.kind));
  return {version:entries.some(e=>e.rows.some(r=>r.observation))?apiSourceVersion:sourceVersion, eligibleAnswers:valid.size,
    coverage:kinds.map(kind => ({kind, answers:answersByKind.get(kind).size, urls:rows.filter(r => r.kind === kind).length,
      observableAnswers:kind === 'source_reference' ? null : observed.get(kind).size})), items:rows};
}
