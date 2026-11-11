import {setting} from './shared.mjs';
// Tracked model API calls only. Guest checks and consumer polling retain their
// own policies. Never shorten an existing global allowance by default.
export function monitoringTimeouts(env){
 const normal=setting(env,'MONITORING_PROVIDER_TIMEOUT_MS',120000,10,600000);
 return {default:normal,kimi:setting(env,'MONITORING_KIMI_TIMEOUT_MS',Math.max(normal,300000),10,600000)};
}
