import test from 'node:test';
import assert from 'node:assert/strict';
import { extract, aggregate, extractionVersion, metricVersion } from '../src/analytics/extraction.mjs';
import { competitorMeasurements } from '../src/analytics/competitors.mjs';
const own = { brandName: 'Aava', aliases: ['Aava Studio'], ownedDomains: ['aava.fi'] };
const rival = { brandName: 'Kajo', aliases: [], ownedDomains: ['kajo.fi'] };
const snapshot = { kind: 'neutral', language: 'fi', identity: own, cohort: { brands: [own, rival] } };
const row = (answer, status = 'success', context = snapshot) =>
  extract({ id: answer, answer, status, citations: [], provider: 'openai' }, context);

test('first mentions preserve verbatim offsets and are independent of explicit list rank', () => {
  const original = '🌟 Kajo ensin. Aava Studio myöhemmin. Aava uudelleen.';
  const result = row(original);
  assert.equal(result.position, null);
  assert.equal(result.brandOrder.targetPosition, 2);
  assert.deepEqual(result.brandOrder.mentions.map(x => x.brandName), ['Kajo', 'Aava']);
  for (const hit of result.brandOrder.mentions) assert.equal(original.slice(hit.start, hit.end), hit.quote);
  assert.equal(result.brandOrder.mentions[1].quote, 'Aava Studio');
  assert.equal(extractionVersion, 'context-aware-literal-fi-en-recommendations-v2');
  assert.equal(metricVersion, 'neutral-valid-weighted-v2-citation-coverage');
});

test('win-rate denominator includes valid absent answers, not failures or unknown cohorts', () => {
  const rows = [row('Aava then Kajo'), row('Kajo then Aava'), row('Neither business'),
    row('Aava', 'truncated'), row('Aava', 'success', { ...snapshot, cohort: undefined })];
  const result = aggregate(rows, 5);
  assert.equal(result.brandOrder.eligibleAnswers, 3);
  assert.equal(result.brandOrder.mentionedAnswers, 2);
  assert.equal(result.brandOrder.firsts, 1);
  assert.equal(result.brandOrder.meanPosition, 1.5);
  assert.equal(result.brandOrder.winRate, 33.3);
  assert.equal(result.brandOrder.unavailableAnswers, 1);
  assert.equal(result.eligible, 4);
});

test('missing historical cohorts remain unavailable, and valid observed zeroes remain zero', () => {
  assert.equal(aggregate([row('Aava', 'success', { ...snapshot, cohort: undefined })], 1).brandOrder.winRate, null);
  const observed = aggregate([row('No tracked brands here')], 1).brandOrder;
  assert.equal(observed.winRate, 0); assert.equal(observed.meanPosition, null);
  assert.equal(aggregate([], 0).brandOrder.winRate, null);
});

test('literal matching respects boundaries, aliases and non-English answer text', () => {
  assert.equal(row('Kaava Kajoa').brandOrder.mentions.length, 0);
  assert.equal(row('Kajo, puis AAVA STUDIO.').brandOrder.targetPosition, 2);
  assert.equal(row('Kajo, затем Aava.', 'success', { ...snapshot, language: 'ru' }).brandOrder.targetPosition, 2);
});

test('shared aliases are ambiguous rather than fabricated wins; nested names use the longest match', () => {
  const shared = { ...snapshot, cohort: { brands: [{ ...own, aliases: ['Shared'] }, { ...rival, aliases: ['Shared'] }] } };
  const ambiguous = row('Shared is useful', 'success', shared);
  assert.equal(ambiguous.brandOrder.state, 'ambiguous');
  assert.equal(aggregate([ambiguous], 1).brandOrder.winRate, null);
  assert.equal(aggregate([ambiguous], 1).brandOrder.ambiguousAnswers, 1);
  const nested = { ...snapshot, cohort: { brands: [own, { ...rival, brandName: 'Aava Cloud' }] } };
  assert.deepEqual(row('Aava Cloud, then Aava.', 'success', nested).brandOrder.mentions.map(x => x.brandName), ['Aava Cloud', 'Aava']);
});

test('frozen competitor rows share the same ranking universe and preserve originals', () => {
  const rawRows = [{ id: 'r', status: 'success', answer: 'Kajo then Aava', provider: 'gemini', citations: [] }];
  const original = JSON.stringify(rawRows);
  const rivals = competitorMeasurements([{ kind: 'neutral', id: 'run', createdAt: 1,
    status: 'completed', group: 'g', snapshot, rawRows, tasks: [{ id: 'r' }] }]);
  assert.equal(rivals[0].metrics.brandOrder.meanPosition, 2);
  assert.equal(rivals[0].metrics.brandOrder.winRate, 0);
  assert.equal(rivals[1].metrics.brandOrder.meanPosition, 1);
  assert.equal(rivals[1].metrics.brandOrder.winRate, 100);
  assert.equal(JSON.stringify(rawRows), original);
});

test('own-brand legacy sentiment never leaks into competitor metrics', () => {
  const rawRows = [{ id: 'sentiment', status: 'success', answer: 'Kajo and Aava', citations: [],
    sentiment: { status: 'analysed', score: 90, label: 'positive', quotes: [] } }];
  const rivals = competitorMeasurements([{ kind: 'neutral', id: 'run', createdAt: 1,
    status: 'completed', group: 'g', snapshot, rawRows, tasks: [{ id: 'sentiment' }] }]);
  assert.equal(rivals[1].metrics.sentiment.score, null);
  assert.equal(rivals[1].metrics.sentiment.sampleSize, 0);
  assert.equal(rawRows[0].sentiment.score, 90);
});

test('normalized-only matches are unavailable rather than assigned incorrect original offsets', () => {
  const result = row('Ａａｖａ and Kajo');
  assert.equal(result.mentioned, true);
  assert.equal(result.brandOrder.state, 'unavailable');
  assert.equal(result.brandOrder.reason, 'unresolved_literal_offsets');
  assert.equal(aggregate([result], 1).brandOrder.winRate, null);
});

test('repeated long answers keep one first mention per brand', () => {
  const answer = 'Kajo. Aava. '.repeat(2000);
  const result = row(answer);
  assert.equal(result.brandOrder.targetPosition, 2);
  assert.equal(result.brandOrder.mentions.length, 2);
  assert.equal(result.brandOrder.mentions[1].start, 6);
});
