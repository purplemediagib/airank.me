// Additive read-time analysis of immutable answers. This is NOT a complete
// entity detector: the comparison universe is the frozen tracked cohort only.
import { containsName } from '../common/scan-profile.mjs';
export const brandOrderVersion = 'tracked-literal-first-mention-v1';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyFor = identity => typeof identity?.brandName === 'string'
  ? identity.brandName.normalize('NFKC').trim().toLowerCase() : '';
const base = () => ({
  version: brandOrderVersion, scope: 'tracked_cohort', state: 'unavailable',
  reason: 'cohort_unavailable', targetPosition: null, mentions: [],
});

export function firstMentionOrder(answer, snapshot, eligible) {
  const result = base(), cohort = snapshot.cohort?.brands;
  if (!eligible) return { ...result, reason: 'ineligible_answer' };
  if (!Array.isArray(cohort) || !cohort.length ||
      !keyFor(snapshot.identity) ||
      !cohort.some(brand => keyFor(brand) === keyFor(snapshot.identity))) return result;
  const candidates = [];
  let unresolvedOffsets = false;
  for (const identity of cohort) {
    if (typeof identity.brandName !== 'string' || !identity.brandName.trim()) return result;
    const key = keyFor(identity);
    for (const name of new Set([identity.brandName, ...(identity.aliases || [])])) {
      if (typeof name !== 'string' || !name.trim()) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name.trim())}(?![\\p{L}\\p{N}])`, 'giu');
      const matches = [...answer.matchAll(pattern)];
      if (!matches.length && containsName(answer, name.trim())) unresolvedOffsets = true;
      for (const match of matches) {
        candidates.push({ key, brandName: identity.brandName, start: match.index,
          end: match.index + match[0].length, quote: match[0] });
      }
    }
  }
  if (unresolvedOffsets) return { ...result, reason: 'unresolved_literal_offsets' };
  // A longer exact brand/alias match wins over a nested shorter name. Equal
  // aliases or crossing spans belonging to different brands remain ambiguous.
  const hits = [];
  let cluster = [], clusterEnd = -1, ambiguous = false;
  const flush = () => {
    const local = cluster.filter(hit => !cluster.some(other =>
      other.key !== hit.key && other.start <= hit.start && other.end >= hit.end &&
      other.end - other.start > hit.end - hit.start));
    ambiguous ||= local.some((hit, i) => local.slice(i + 1).some(other =>
      other.key !== hit.key && hit.start < other.end && other.start < hit.end));
    hits.push(...local); cluster = [];
  };
  // Resolve only locally overlapping spans, not every pair in a long answer.
  for (const hit of candidates.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (hit.start >= clusterEnd) flush();
    cluster.push(hit); clusterEnd = Math.max(clusterEnd, hit.end);
  }
  flush();
  const first = new Map();
  for (const hit of hits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!first.has(hit.key)) first.set(hit.key, hit);
  }
  const mentions = [...first.values()].map(({ key, ...hit }, index) => ({
    ...hit, position: ambiguous ? null : index + 1,
  }));
  return {
    ...result, state: ambiguous ? 'ambiguous' : 'observed',
    reason: ambiguous ? 'overlapping_brand_aliases' : null, mentions,
    targetPosition: ambiguous ? null : mentions.find(hit =>
      keyFor(hit) === keyFor(snapshot.identity))?.position ?? null,
  };
}

export function aggregateBrandOrder(valid) {
  const observed = valid.filter(row => row.brandOrder?.version === brandOrderVersion &&
    row.brandOrder?.state === 'observed');
  const ranked = observed.filter(row => row.brandOrder.targetPosition !== null);
  const firsts = ranked.filter(row => row.brandOrder.targetPosition === 1).length;
  const ambiguousAnswers = valid.filter(row => row.brandOrder?.state === 'ambiguous').length;
  return {
    version: brandOrderVersion, scope: 'tracked_cohort', eligibleAnswers: observed.length,
    mentionedAnswers: ranked.length, firsts, ambiguousAnswers,
    unavailableAnswers: valid.length - observed.length - ambiguousAnswers,
    meanPosition: ranked.length ? Math.round(ranked.reduce((sum, row) =>
      sum + row.brandOrder.targetPosition, 0) / ranked.length * 10) / 10 : null,
    winRate: observed.length ? Math.round(firsts / observed.length * 1000) / 10 : null,
  };
}
