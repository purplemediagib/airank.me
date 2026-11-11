import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoringTimeouts} from '../src/monitoring/provider-timeouts.mjs';
test('Kimi gets five minutes without changing other providers or shortening larger limits',()=>{
 assert.deepEqual(monitoringTimeouts({MONITORING_PROVIDER_TIMEOUT_MS:'180000'}),{default:180000,kimi:300000});
 assert.deepEqual(monitoringTimeouts({MONITORING_PROVIDER_TIMEOUT_MS:'400000'}),{default:400000,kimi:400000});
 assert.deepEqual(monitoringTimeouts({MONITORING_PROVIDER_TIMEOUT_MS:'180000',MONITORING_KIMI_TIMEOUT_MS:'240000'}),{default:180000,kimi:240000});
 for(const value of ['bad','0','600001'])assert.throws(()=>monitoringTimeouts({MONITORING_KIMI_TIMEOUT_MS:value}));
});
