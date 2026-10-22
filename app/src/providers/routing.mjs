import {consumerRoutes} from '../collectors/config.mjs';
// Guest routes stay API-only. Consumer selection is restricted to tracked monitoring.
export const monitoringRoutesFromEnv=(env=process.env)=>consumerRoutes(env,routesFromEnv(env));
// No secrets in route descriptors: these are persisted in benchmark snapshots.
export function routesFromEnv(env=process.env){
 const enabled=[...new Set((env.ENABLED_PROVIDERS||'openai,claude').split(',').map(x=>x.trim()).filter(Boolean))];
 let extra={};try{extra=JSON.parse(env.OPENROUTER_MODELS_JSON||'{}');}catch{throw Error('OPENROUTER_MODELS_JSON must be a JSON object');}
 if(!extra||Array.isArray(extra)||typeof extra!=='object')throw Error('OPENROUTER_MODELS_JSON must be an object');
 for(const [k,v] of Object.entries(extra))if(!/^[a-z][a-z0-9_]{1,39}$/.test(k)||['openai','claude','google_aio','grok','perplexity','copilot'].includes(k)||typeof v!=='string')throw Error('Invalid/reserved OpenRouter provider mapping');
 const engine=env.OPENROUTER_SEARCH_ENGINE||'native';if(!['native','exa'].includes(engine))throw Error('OPENROUTER_SEARCH_ENGINE must be native or exa');
 const map={gemini:env.OPENROUTER_GEMINI_MODEL||'google/gemini-3.8-flash',...extra},routes={};
 for(const p of enabled){
 if(p==='openai')routes[p]={transport:'direct',model:env.OPENAI_MODEL||'gpt-4.1-mini'};
 else if(p==='claude')routes[p]={transport:'direct',model:env.CLAUDE_MODEL||'claude-sonnet-4-5'};
 else if(p==='grok')routes[p]={transport:'direct',model:env.GROK_MODEL||'grok-4.7'};
 else if(p==='perplexity')routes[p]={transport:'direct',model:'perplexity-agent/fast'};
 else if(p==='google_aio')routes[p]={transport:'dataforseo',model:'Google AI Overviews / desktop SERP'};
 else{if(p==='copilot')throw Error('Consumer Copilot is deferred; an OpenRouter model is not Copilot');
 const model=map[p];if(!model||!/^[-\w.]+\/[-\w.]+$/.test(model)||/^(openai|anthropic|openrouter)\//.test(model))throw Error('Configure an explicit non-OpenAI/non-Anthropic OpenRouter model for '+p);
 routes[p]={transport:'openrouter',model,search_engine:engine};}
 }
 if(!enabled.length)throw Error('Enable at least one provider');return routes;
}
export function routeAvailable(p,route,env=process.env){
 if(route?.transport==='dataforseo_scraper')return !!(env.DATAFORSEO_LOGIN&&env.DATAFORSEO_PASSWORD);
 if(route?.transport==='scrapeless')return !!env.SCRAPELESS_API_TOKEN;
 if(route?.transport==='openrouter')return !!env.OPENROUTER_API_KEY;
 if(route?.transport==='direct'&&p==='openai')return !!env.OPENAI_API_KEY;
 if(route?.transport==='direct'&&p==='claude')return !!env.ANTHROPIC_API_KEY;
 if(route?.transport==='direct'&&p==='grok')return !!env.XAI_API_KEY;
 if(route?.transport==='direct'&&p==='perplexity')return !!env.PERPLEXITY_API_KEY;
 if(route?.transport==='dataforseo'&&p==='google_aio')return !!(env.DATAFORSEO_LOGIN&&env.DATAFORSEO_PASSWORD);
 return false;
}
export function compatibleRoute(old,current){return !!current&&old?.transport===current.transport&&old?.model===current.model&&old?.search_engine===current.search_engine;}

// Expanding authenticated measurement must never add paid calls to guest scans.
export function publicProviders(config){
 return [...new Set(config.enabledProviders)].filter(p=>['openai','claude'].includes(p));
}

export function providersForScan({requested,enabled,platform}){
 const selected=[...new Set(requested||enabled)];
 return platform?selected:selected.filter(p=>['openai','claude'].includes(p));
}
