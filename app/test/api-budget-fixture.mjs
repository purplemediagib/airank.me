import {routesFromEnv} from '../src/providers/routing.mjs';

// Synthetic prices exclusively for offline tests; never production defaults.
export function fixtureBudgetConfig(env,{dailyUsd=10000,...overrides}={}){
 return JSON.stringify({dailyUsd,routes:Object.fromEntries(Object.entries(routesFromEnv(env)).map(([provider,route])=>[
  provider,{transport:route.transport,model:route.model,...(route.search_engine?{searchEngine:route.search_engine}:{}),
   contextWindowTokens:200000,maxInputBytes:10000,maxReplayBytes:100000,
   inputUsdPerMillion:2,outputUsdPerMillion:3,searchUsdPerCall:0.01,requestUsd:0.05,...overrides},
 ]))});
}
