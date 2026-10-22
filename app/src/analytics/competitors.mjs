import { extract, aggregate } from './extraction.mjs';
import { brandKey } from '../sentiment/core.mjs';
import {collectionSurface,methodFor,metricsFor} from '../common/observations.mjs';

/** Entries are already ownership-checked, filtered, and restricted to one composition. */
export function competitorMeasurements(entries) {
  entries = entries.filter(entry => entry.kind === 'neutral');
  const snapshot = entries[0]?.snapshot;
  const brands = snapshot?.cohort?.brands;
  if (!Array.isArray(brands)) return [];
  if(new Set(entries.map(entry=>entry.group)).size>1)return [];
  // Never project today's/first run's cohort onto a different frozen cohort.
  const frozen=JSON.stringify(snapshot.cohort);
  if(entries.some(entry=>JSON.stringify(entry.snapshot.cohort)!==frozen))return [];
  const contexts=new Set(entries.flatMap(entry=>(entry.rows||entry.rawRows||[]).map(row=>JSON.stringify([
    collectionSurface(row,entry.snapshot),methodFor(entry.snapshot,row),metricsFor(entry.snapshot,row)]))));
  if(contexts.size>1)return [];
  return brands.map((identity, index) => {
    const metrics = (rows, expected) => ({
      ...aggregate(rows, expected),
      ...(!identity.ownedDomains?.length ? { citationRate: null } : {}),
    });
    const runs = entries.map(entry => {
      // Legacy `sentiment` belongs to the project's own identity. Never reuse it
      // for a competitor when no explicit per-brand assessment exists.
      const own = brandKey(identity) === brandKey(entry.snapshot.identity);
      const rows = entry.rawRows.map(row => extract(own ? row : { ...row, sentiment: undefined }, { ...entry.snapshot, identity }));
      return {
        id: entry.id, createdAt: entry.createdAt, kind: entry.kind, status: entry.status,
        group: entry.group, comparableToPrevious: false,
        metrics: metrics(rows, entry.tasks.length), rows,
      };
    });
    const eligibleRuns = runs.filter(run => run.metrics.eligible > 0);
    const latest = eligibleRuns.at(-1), previous = eligibleRuns.at(-2);
    const comparable = latest && previous && latest.group === previous.group;
    for (let i = 1; i < runs.length; i++) {
      runs[i].comparableToPrevious = runs[i].metrics.eligible > 0 &&
        runs[i - 1].metrics.eligible > 0 && runs[i].group === runs[i - 1].group;
    }
    return {
      brandName: identity.brandName, ownedDomains: identity.ownedDomains || [],
      isOwned: index === 0 && identity.brandName === snapshot.identity.brandName,
      metrics: metrics(runs.flatMap(run => run.rows), entries.reduce((n, e) => n + e.tasks.length, 0)),
      runCount: runs.length, eligibleRunCount: eligibleRuns.length,
      change: comparable ? Math.round((latest.metrics.visibility - previous.metrics.visibility) * 10) / 10 : null,
      runs: runs.map(({ rows, ...run }) => run),
    };
  });
}
