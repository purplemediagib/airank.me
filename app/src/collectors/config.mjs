export const isCollectorRoute=route=>route?.measurement_surface==='consumer_web'&&['dataforseo_scraper','scrapeless'].includes(route?.transport);
export function consumerRoutes(env,routes){
 const chosen=(env.CONSUMER_COLLECTION_PROVIDERS||'').split(',').map(x=>x.trim()).filter(Boolean);
 if(new Set(chosen).size!==chosen.length||chosen.some(p=>!['openai','gemini','grok','perplexity'].includes(p)))throw Error('Invalid CONSUMER_COLLECTION_PROVIDERS; Claude consumer collection and Copilot are not supported');
 return Object.fromEntries(Object.entries(routes).map(([provider,route])=>[provider,chosen.includes(provider)?{
  transport:['openai','gemini'].includes(provider)?'dataforseo_scraper':'scrapeless',
  model:'consumer-auto',measurement_surface:'consumer_web',collector_version:'consumer-evidence-v1',
  ...(provider==='grok'?{mode:'MODEL_MODE_AUTO'}:{}),
 }:route]));
}
export function collectionBudget(env,provider){
 const daily=Number(env.CONSUMER_MAX_DAILY_COST_USD);
 let prices;try{prices=JSON.parse(env.CONSUMER_UNIT_COSTS_JSON||'{}');}catch{return null;}
 const unit=prices?.[provider];
 return Number.isFinite(daily)&&daily>0&&typeof unit==='number'&&Number.isFinite(unit)&&unit>0&&unit<=daily?{daily,unit}:null;
}
