export function scanLimitError({ recentCount, weeklyCount, authenticated, dashboardScan = false }, env = process.env) {
  // Temporary test switch for the authenticated app dashboard route only.
  // Signed-in users of public/legacy checker routes still get normal caps.
  if (dashboardScan && authenticated && env.DISABLE_AUTHENTICATED_SCAN_LIMITS === 'true') return null;
  if (env.APP_ENV === 'staging' && env.DISABLE_FREE_SCAN_LIMITS === 'true') return null;
  if (Number(recentCount || 0) >= 1 && !authenticated) {
    return { error: 'Free scan limit reached for the past 24 hours', code: 'RATE_LIMIT' };
  }
  if (Number(weeklyCount || 0) >= 5) {
    return { error: 'This domain has reached its weekly scan limit', code: 'DOMAIN_RATE_LIMIT' };
  }
  return null;
}
