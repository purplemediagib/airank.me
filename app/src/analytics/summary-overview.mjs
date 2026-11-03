/** overview-ui-v1. Exact UI formulas ported from Lovable 0e0e128022d55463760af942f594c9948263a7df.
 * Intentionally preserves legacy observedAt date basis, daily denominators, and weekly timestamp behavior.
 * Do not change numeric meaning in a performance migration. Source fingerprints:
 * overview-data.ts 7bc7c0a12cac31cef8292f27b55dddb917c45854ba70a9fd610481194df9d524
 * overview-headline.ts 17bce650cf3f9240b4a197b94bc24f469ae13def6e7bc257a442778911331a8a
 * overview-daily.ts 1c383380edb3c558b9a3a2906a8c4ee062c62dbcc7bb6067eee28f243e5d1962
 * perception-stats.ts 8dc81c69caecd886b5e0d2a05948c8138234078bcdc2a404e44ebdaa05237dd3
 * gap-insights.ts 933263402f16a35658d4a99681365dc57680ac35d6246182e4bfd891ba7b0299
 */
const toMs = n => n < 1e12 ? n * 1000 : n;
const scoped = (() => {
function scopeEvidence(a, f) {
    const start = Date.parse(`${f.from}T00:00:00Z`);
    const end = Date.parse(`${f.to}T00:00:00Z`) + 86_400_000;
    const groupRuns = a.selectedGroup ? new Set(a.runs.filter((r) => r.group === a.selectedGroup).map((r) => r.id)) : null;
    return a.evidence
        .filter((e) => {
        const t = toMs(e.observedAt);
        if (t < start || t >= end)
            return false;
        if (f.provider !== 'all' && e.provider !== f.provider)
            return false;
        if (f.topic !== 'all' && e.topic !== undefined && e.topic !== f.topic)
            return false;
        const tags = [...new Set([...(f.tags ?? []), ...(f.tag && f.tag !== 'all' ? [f.tag] : [])])];
        if (tags.length && (f.tagMode === 'and' ? !tags.every(t => e.tags?.includes(t)) : !tags.some(t => e.tags?.includes(t))))
            return false;
        if (f.market && f.market !== 'all' && e.market !== f.market)
            return false;
        if (f.language && f.language !== 'all' && e.language !== f.language)
            return false;
        if (f.surface && f.surface !== 'all' && e.measurementSurface !== f.surface)
            return false;
        if (f.promptId && f.promptId !== 'all' && e.promptId !== f.promptId)
            return false;
        if (f.promptVersion && Number(f.promptVersion) !== e.promptVersion)
            return false;
        if (groupRuns && e.runId && !groupRuns.has(e.runId))
            return false;
        return true;
    })
        .sort((x, y) => toMs(y.observedAt) - toMs(x.observedAt) || x.id.localeCompare(y.id));
}
function matchEvidence(e, filter, query) {
    const ok = e.exclusion === null;
    const byFilter = filter === 'mentioned' ? ok && e.mentioned
        : filter === 'recommended' ? ok && e.recommendation === 'recommended'
            : filter === 'cited' ? ok && e.ownedCitation
                : filter === 'ordered' ? ok && e.brandOrder?.state === 'observed' && e.brandOrder.targetPosition !== null
                    : filter === 'first' ? ok && e.brandOrder?.state === 'observed' && e.brandOrder.targetPosition === 1
                        : filter === 'excluded' ? !ok : true;
    if (!byFilter)
        return false;
    const q = query.trim().toLocaleLowerCase();
    if (!q)
        return true;
    return [e.text, e.answer, e.provider, e.model, e.topic ?? '', ...(e.tags ?? []), ...(e.brandNames ?? []), ...e.citations]
        .some((s) => (s ?? '').toLocaleLowerCase().includes(q));
}

return { scopeEvidence, matchEvidence };
})();
const headline = (() => {
/** Caller supplies the exact filtered, selected-setup evidence used by the drawer.
 * Match the drawer's eligibility rule: unavailable/excluded answers never count.
 */
function headlineModels(evidence) {
    const eligible = evidence.filter(e => e.exclusion === null);
    const all = [...new Set(eligible.map(e => e.provider))];
    const mentioning = all.filter(p => eligible.some(e => e.provider === p && e.mentioned));
    return { all, mentioning };
}

return { headlineModels };
})();
const insights = (() => {
const usable = (e) => !e.exclusion;
const host = (u) => { try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
}
catch {
    return '';
} };
const others = (e, own) => (e.brandNames ?? []).filter((b) => b.trim() && b.toLocaleLowerCase() !== own.toLocaleLowerCase());
/** Prompts where answers name competitors but not you, ranked by number of such answers. */
function gapPrompts(evidence, ownBrand) {
    const m = new Map();
    for (const e of evidence.filter(usable)) {
        const g = m.get(e.promptId) ?? { promptId: e.promptId, text: e.text, gaps: 0, answers: 0, competitors: [], providers: [], c: new Map(), p: new Set() };
        g.answers++;
        const rivals = others(e, ownBrand);
        if (!e.mentioned && rivals.length) {
            g.gaps++;
            rivals.forEach((r) => g.c.set(r, (g.c.get(r) ?? 0) + 1));
            g.p.add(e.provider);
        }
        m.set(e.promptId, g);
    }
    return [...m.values()].filter((g) => g.gaps > 0)
        .map(({ c, p, ...g }) => ({ ...g, competitors: [...c.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 3), providers: [...p].sort() }))
        .sort((a, b) => b.gaps - a.gaps || b.gaps / b.answers - a.gaps / a.answers);
}
/** Domains cited in answers naming competitors but not you, never cited where you are named, excluding your own domains. */
function sourceOpportunities(evidence, ownBrand, ownDomains) {
    const own = new Set(ownDomains.map((d) => d.replace(/^www\./, '').toLowerCase()));
    const withYou = new Set();
    const m = new Map();
    for (const e of evidence.filter(usable)) {
        const hosts = [...new Set(e.citations.map(host).filter(Boolean))];
        if (e.mentioned) {
            hosts.forEach((h) => withYou.add(h));
            continue;
        }
        const rivals = others(e, ownBrand);
        if (!rivals.length)
            continue;
        for (const h of hosts) {
            const v = m.get(h) ?? { n: 0, c: new Set() };
            v.n++;
            rivals.forEach((r) => v.c.add(r));
            m.set(h, v);
        }
    }
    return [...m.entries()].filter(([h]) => !withYou.has(h) && !own.has(h))
        .map(([domain, v]) => ({ domain, competitorAnswers: v.n, competitors: [...v.c].slice(0, 3) }))
        .sort((a, b) => b.competitorAnswers - a.competitorAnswers || a.domain.localeCompare(b.domain));
}
const DAY = 86_400_000;
/** Last 7 days vs the 7 days before, anchored on the newest answer. */
function weeklyDigest(evidence, ownBrand) {
    const ev = evidence.filter(usable);
    if (!ev.length)
        return null;
    const end = Math.max(...ev.map((e) => e.observedAt));
    const cur = ev.filter((e) => e.observedAt > end - 7 * DAY);
    const prev = ev.filter((e) => e.observedAt <= end - 7 * DAY && e.observedAt > end - 14 * DAY);
    const vis = (l) => (l.length ? Math.round((l.filter((e) => e.mentioned).length / l.length) * 1000) / 10 : null);
    const set = (l, f) => new Set(l.flatMap(f));
    const brands = (l) => set(l, (e) => others(e, ownBrand));
    const doms = (l) => set(l, (e) => e.citations.map(host).filter(Boolean));
    const fresh = (a, b) => (prev.length ? [...a].filter((x) => !b.has(x)).sort() : []);
    const byPrompt = (l) => { const m = new Map(); l.forEach((e) => { const v = m.get(e.promptId) ?? { t: e.text, y: 0, n: 0 }; v.n++; if (e.mentioned)
        v.y++; m.set(e.promptId, v); }); return m; };
    const pc = byPrompt(cur), pp = byPrompt(prev);
    const wins = [], losses = [];
    pc.forEach((v, id) => { const p = pp.get(id); if (!p)
        return; if (v.y > 0 && p.y === 0)
        wins.push(v.t); if (v.y === 0 && p.y > 0)
        losses.push(v.t); });
    return { current: { answers: cur.length, visibility: vis(cur) }, previous: { answers: prev.length, visibility: vis(prev) }, newCompetitors: fresh(brands(cur), brands(prev)), newDomains: fresh(doms(cur), doms(prev)), wins, losses };
}

return { weeklyDigest, gapPrompts, sourceOpportunities };
})();
const perception = (() => {
const LABELS = ['strongly_positive', 'positive', 'neutral', 'negative', 'strongly_negative', 'mixed'];
const usable = (e) => !e.exclusion && (e.kind ?? 'neutral') !== 'diagnostic';
/** `pick` returns the result for the brand being measured; null = brand not in this answer's cohort. */
function sentimentStats(evidence, pick) {
    const mentioned = [];
    for (const e of evidence) {
        if (!usable(e))
            continue;
        const s = pick(e);
        if (!s || s.status === 'not_mentioned')
            continue;
        if (typeof s.score !== 'number' && (e.status ?? 'success') !== 'success')
            continue;
        mentioned.push({ e, s });
    }
    const assessed = mentioned.filter((m) => typeof m.s.score === 'number');
    const labelCounts = Object.fromEntries(LABELS.map((k) => [k, 0]));
    const states = {};
    for (const m of mentioned) {
        const k = typeof m.s.score === 'number' ? 'done' : m.s.status || 'not_analysed';
        states[k] = (states[k] ?? 0) + 1;
    }
    for (const m of assessed)
        if (m.s.label && m.s.label in labelCounts)
            labelCounts[m.s.label]++;
    const attrs = new Map();
    for (const { e, s } of assessed) {
        const local = new Map();
        for (const q of s.quotes ?? []) {
            if (!q.attribute)
                continue;
            const name = q.attribute.normalize('NFKC').toLocaleLowerCase();
            const set = local.get(name) ?? new Set();
            set.add((q.score ?? 50) > 50 ? 'positive' : (q.score ?? 50) < 50 ? 'negative' : 'neutral');
            local.set(name, set);
        }
        for (const [name, set] of local) {
            const a = attrs.get(name) ?? { attribute: name, answers: 0, positiveAnswers: 0, negativeAnswers: 0, neutralAnswers: 0, exampleEvidenceIds: [] };
            a.answers++;
            if (set.has('positive'))
                a.positiveAnswers++;
            if (set.has('negative'))
                a.negativeAnswers++;
            if (set.has('neutral'))
                a.neutralAnswers++;
            if (a.exampleEvidenceIds.length < 5)
                a.exampleEvidenceIds.push(e.id);
            attrs.set(name, a);
        }
    }
    const score = assessed.length ? Math.round(assessed.reduce((n, m) => n + m.s.score, 0) / assessed.length * 10) / 10 : null;
    return {
        score, sampleSize: assessed.length, mentionedAnswers: mentioned.length,
        coverage: mentioned.length ? Math.round(assessed.length / mentioned.length * 1000) / 10 : null,
        labelCounts, states, versions: new Set(assessed.map((m) => m.s.analysisVersion ?? '')).size,
        attributes: [...attrs.values()].sort((a, b) => b.answers - a.answers || a.attribute.localeCompare(b.attribute)).slice(0, 30),
        state: !assessed.length ? 'unavailable' : assessed.length < mentioned.length ? 'partial' : 'complete', groups: [],
    };
}
const brandPick = (name) => (e) => Object.values(e.brandSentiments ?? {}).find((b) => b.brandName?.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? null;
const ownPick = (e) => e.sentiment ?? null;
/** Answers that could not be assessed, by provider and reason (failed collection, not configured, …). */
function gapsByProvider(evidence) {
    const out = new Map();
    for (const e of evidence) {
        if (!usable(e))
            continue;
        const reason = (e.status ?? 'success') !== 'success' ? e.status : typeof e.sentiment?.score === 'number' || e.sentiment?.status === 'not_mentioned' ? null : e.sentiment?.status || 'not_analysed';
        if (!reason)
            continue;
        const r = out.get(e.provider) ?? {};
        r[reason] = (r[reason] ?? 0) + 1;
        out.set(e.provider, r);
    }
    return [...out.entries()].map(([provider, reasons]) => ({ provider, reasons }));
}

return { ownPick, sentimentStats };
})();
const daily = (() => {
const { ownPick, sentimentStats } = perception;
const trendRanges = ['7', '28', '90', 'all'];
const DAY = 86_400_000;
const ms = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const eligible = (e) => !e.exclusion && e.kind !== 'diagnostic';
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** One day's value, computed from that day's saved answers with each metric's own denominator. */
function dayValue(list, metric) {
    const ok = list.filter(eligible);
    if (!ok.length)
        return null;
    switch (metric) {
        case 'visibility': return ok.filter((e) => e.mentioned).length / ok.length;
        case 'citations': return ok.filter((e) => e.ownedCitation).length / ok.length;
        case 'recommendations': {
            const c = ok.filter((e) => e.recommendation && e.recommendation !== 'unknown');
            return c.length ? c.filter((e) => e.recommendation === 'recommended').length / c.length : null;
        }
        case 'share': {
            let own = 0, all = 0;
            for (const e of ok) {
                const names = new Set((e.brandOrder?.mentions ?? []).map((m) => m.brandName.toLowerCase()));
                for (const n of e.brandNames ?? [])
                    names.add(n.toLowerCase());
                const total = Math.max(names.size, e.mentioned ? 1 : 0);
                all += total;
                own += e.mentioned ? 1 : 0;
            }
            return all ? own / all : null;
        }
        case 'listRank': return mean(ok.map((e) => e.position).filter((p) => typeof p === 'number'));
        case 'position': return mean(ok.filter((e) => e.brandOrder?.state === 'observed').map((e) => e.brandOrder.targetPosition).filter((p) => typeof p === 'number'));
        case 'winRate': {
            const o = ok.filter((e) => e.brandOrder?.state === 'observed' && (e.brandOrder.mentions?.length ?? 0) > 0);
            return o.length ? o.filter((e) => e.brandOrder.targetPosition === 1).length / o.length : null;
        }
        case 'sentiment': return sentimentStats(ok, ownPick).score;
    }
}
/** Daily points from the first tracking day (or today − range, whichever is later) to today. Days without answers stay null. */
function dailySeries(evidence, metric, range, now = Date.now()) {
    const byDay = new Map();
    for (const e of evidence) {
        const t = ms(e.observedAt);
        if (Number.isFinite(t)) {
            const d = dayOf(t);
            byDay.set(d, [...(byDay.get(d) ?? []), e]);
        }
    }
    const days = [...byDay.keys()].sort();
    if (!days.length)
        return { firstDay: null, points: [] };
    const today = dayOf(now);
    const first = days[0];
    const rangeStart = range === 'all' ? first : dayOf(Date.parse(`${today}T00:00:00Z`) - (Number(range) - 1) * DAY);
    const start = rangeStart > first ? rangeStart : first;
    const points = [];
    for (let t = Date.parse(`${start}T00:00:00Z`); dayOf(t) <= today && points.length < 3660; t += DAY) {
        const d = dayOf(t);
        const list = byDay.get(d) ?? [];
        points.push({ date: d, value: dayValue(list, metric), answers: list.length });
    }
    return { firstDay: first, points };
}

return { dailySeries, dayValue };
})();

export const OVERVIEW_UI_VERSION = 'overview-ui-v1';
export const OVERVIEW_METRICS = ['visibility','share','sentiment','citations','recommendations','winRate','position','listRank'];
export const matchEvidence = scoped.matchEvidence;
export const dayValue = daily.dayValue;
export const dailySeries = daily.dailySeries;
export function matchesEvidenceBrand(e, brand) {
  return !brand || (e.brandOrder?.mentions.some(m => m.brandName === brand) ?? e.brandNames?.includes(brand)) === true;
}
export function normalizeOverviewFilters(filters) {
  let tags = [];
  if (Array.isArray(filters.tags)) tags = filters.tags;
  else if (filters.tags) { try { tags = JSON.parse(filters.tags); } catch {} }
  return { ...filters, provider: filters.provider || 'all', topic: filters.topic || 'all',
    tag: filters.tag || 'all', tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string') : [],
    tagMode: filters.tagMode || 'or', market: filters.market || 'all', language: filters.language || 'all',
    surface: filters.surface || 'all', promptId: filters.promptId || 'all',
    promptVersion: filters.promptVersion == null ? '' : String(filters.promptVersion) };
}
export const scopeEvidence = (analytics, filters) => scoped.scopeEvidence(analytics, normalizeOverviewFilters(filters));
export function buildOverviewSummary({ analytics, allEvidence, project, filters, now = Date.now() }) {
  const evidence = scopeEvidence(analytics, filters);
  const brand = project.brandName || '';
  const domains = project.ownedDomains || [];
  const deriveInsights = rows => ({
    weeklyDigest: insights.weeklyDigest(rows, brand),
    gapPrompts: insights.gapPrompts(rows, brand).slice(0, 6),
    sourceOpportunities: insights.sourceOpportunities(rows, brand, domains).slice(0, 6),
    total: rows.length,
  });
  const providers = new Map();
  for (const e of analytics.evidence) {
    if (!e.exclusion) continue;
    const reasons = providers.get(e.provider) || new Map();
    reasons.set(e.exclusion, (reasons.get(e.exclusion) || 0) + 1);
    providers.set(e.provider, reasons);
  }
  const byBrand = Object.fromEntries([...new Set((analytics.competitors || []).map(b => b.brandName))]
    .map(name => [name, deriveInsights(evidence.filter(e => matchesEvidenceBrand(e, name)))]));
  // Caller supplies the same per-setup evidence union used by the original useAllSetups.
  const unique = new Map();
  for (const row of allEvidence || analytics.evidence) unique.set(row.id, row);
  return { evidence, ui: {
    version: OVERVIEW_UI_VERSION,
    models: headline.headlineModels(evidence),
    ...deriveInsights(evidence),
    providerExclusions: Object.fromEntries([...providers].map(([provider,reasons]) => [provider,Object.fromEntries(reasons)])),
    daily: Object.fromEntries(OVERVIEW_METRICS.map(metric => [metric,daily.dailySeries([...unique.values()], metric, 'all', now)])),
    byBrand,
  }};
}
