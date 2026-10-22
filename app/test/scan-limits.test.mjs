import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLimitError } from '../src/common/scan-limits.mjs';
const exhausted = {recentCount: 10, weeklyCount: 10, authenticated: false};
test('explicit staging switch permits repeated scans', () => {
  assert.equal(scanLimitError(exhausted, {APP_ENV:'staging', DISABLE_FREE_SCAN_LIMITS:'true'}), null);
});
test('production and unspecified environments enforce limits even with switch', () => {
  for(const APP_ENV of ['production', '', undefined]) {
    assert.equal(scanLimitError(exhausted, {APP_ENV, DISABLE_FREE_SCAN_LIMITS:'true'}).code, 'RATE_LIMIT');
  }
});
test('staging requires an explicit true switch', () => {
  for(const flag of [undefined, 'false', 'TRUE']) assert.equal(scanLimitError(exhausted, {APP_ENV:'staging', DISABLE_FREE_SCAN_LIMITS:flag}).code, 'RATE_LIMIT');
});
test('authenticated testing bypass never disables anonymous scan caps', () => {
  const env={APP_ENV:'production',DISABLE_AUTHENTICATED_SCAN_LIMITS:'true'};
  assert.equal(scanLimitError({...exhausted,authenticated:true,dashboardScan:true},env),null);
  assert.equal(scanLimitError({...exhausted,authenticated:true},env).code,'DOMAIN_RATE_LIMIT');
  assert.equal(scanLimitError(exhausted,env).code,'RATE_LIMIT');
  assert.equal(scanLimitError({recentCount:0,weeklyCount:5,authenticated:false},env).code,'DOMAIN_RATE_LIMIT');
});
test('normal guest, authenticated and weekly policies remain intact', () => {
  assert.equal(scanLimitError({recentCount:0, weeklyCount:4}, {}), null);
  assert.equal(scanLimitError({recentCount:1, weeklyCount:4}, {}).code, 'RATE_LIMIT');
  assert.equal(scanLimitError({recentCount:1, weeklyCount:4, authenticated:true}, {}), null);
  assert.equal(scanLimitError({recentCount:1, weeklyCount:5, authenticated:true}, {}).code, 'DOMAIN_RATE_LIMIT');
});
