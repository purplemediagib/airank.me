import {monitoringRoutesFromEnv as routesFromEnv,routeAvailable,publicProviders} from '../providers/routing.mjs';
import {collectionBudget,isCollectorRoute} from '../collectors/config.mjs';
import {claudeOutputBudget} from '../providers/claude.mjs';
export function workerConfiguration(env=process.env){
 const routes=routesFromEnv(env);
 const credentialNames={openai:['OPENAI_API_KEY'],claude:['ANTHROPIC_API_KEY'],grok:['XAI_API_KEY'],perplexity:['PERPLEXITY_API_KEY'],google_aio:['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD']};
 return {
  monitoring_enabled:env.MONITORING_ENABLED==='true',
  claude_max_output_tokens:claudeOutputBudget(env),
  consumer_collection_enabled:env.CONSUMER_COLLECTION_ENABLED==='true',
  sentiment_enabled:env.SENTIMENT_ENABLED==='true',
  sentiment_model:env.SENTIMENT_MODEL||'gpt-4.1-mini-2025-04-14',
  sentiment_daily_call_limit:Number(env.SENTIMENT_MAX_DAILY_CALLS||100),
  sentiment_credential_present:Boolean(env.OPENAI_API_KEY?.trim()),
  scheduler_enabled:env.PROJECT_SCHEDULER_ENABLED==='true',
  database_configured:Boolean(env.BUNNY_DATABASE_URL&&env.BUNNY_DATABASE_AUTH_TOKEN),
  public_providers:publicProviders({enabledProviders:Object.keys(routes)}),
  providers:Object.entries(routes).map(([provider,route])=>({provider,...route,credential_present:routeAvailable(provider,route,env),...(isCollectorRoute(route)?{budget_configured:!!collectionBudget(env,provider)}:{}),missing_variables:(route.transport==='dataforseo_scraper'?['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD']:route.transport==='scrapeless'?['SCRAPELESS_API_TOKEN']:route.transport==='openrouter'?['OPENROUTER_API_KEY']:credentialNames[provider]||[]).filter(k=>!env[k]?.trim())})),
  monitoring_concurrency:Number(env.MONITORING_CONCURRENCY||2),
  monitoring_timeout_ms:Number(env.MONITORING_PROVIDER_TIMEOUT_MS||120000),
  daily_provider_call_limit:Number(env.MAX_DAILY_PROVIDER_CALLS||200),
  quick_scan_call_limit:Number(env.MAX_PROVIDER_CALLS_PER_SCAN||18),
  note:'Presence checks only. A successful fresh measurement verifies provider access.'
 };
}
