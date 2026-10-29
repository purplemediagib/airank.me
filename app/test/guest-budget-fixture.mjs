import {routesFromEnv} from '../src/providers/routing.mjs';
// Synthetic guest prices exclusively for offline tests; never production values.
export function fixtureGuestBudget(env={},{perScanUsd=1000,dailyUsd=10000,providers=['openai','gemini'],...overrides}={}){
 const routes=routesFromEnv({...env,ENABLED_PROVIDERS:providers.join(',')});
 return JSON.stringify({perScanUsd,dailyUsd,routes:Object.fromEntries(Object.entries(routes).map(([provider,route])=>[provider,{
  transport:route.transport,model:route.model,...(route.search_engine?{searchEngine:route.search_engine}:{}),
  contextWindowTokens:200000,maxInputBytes:10000,inputUsdPerMillion:2,outputUsdPerMillion:3,searchUsdPerCall:0.01,...overrides}]))});
}
