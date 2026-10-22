import {openaiSearch} from './openai.mjs';
import {claudeSearch} from './claude.mjs';
import {openrouterSearch} from './openrouter.mjs';
import {grokSearch,perplexitySearch} from './grounded-responses.mjs';
import {googleAioSearch} from './google-aio.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
import {isCollectorRoute} from '../collectors/config.mjs';
import {enforceBudgetInput} from './budget-config.mjs';
export async function callRoute(provider,prompt,route,timeoutMs,context={}){
 if(isCollectorRoute(route))throw Error('Consumer routes require durable monitoring execution');
 context=measurementContext(context);
 const budget=route.api_budget;
 enforceBudgetInput(budget,provider,route,prompt,context);
 const limits=budget?{budget,maxTokens:budget.maxTokens}:{};
 if(route.transport==='openrouter')return openrouterSearch(prompt,{model:route.model,searchEngine:route.search_engine,timeoutMs,context,...limits});
 if(route.transport==='dataforseo'&&provider==='google_aio'){
  const r=await googleAioSearch(prompt,{timeoutMs,context});
  r.meta={...r.meta,transport:route.transport,requested_model:route.model,context};return r;
 }
 const fn=provider==='openai'?openaiSearch:provider==='claude'?claudeSearch:provider==='grok'?grokSearch:provider==='perplexity'?perplexitySearch:null;
 if(!fn)throw Error('Unsupported direct provider');
 const r=await fn(prompt,{model:route.model,timeoutMs,context,...limits});r.meta={...r.meta,transport:'direct',requested_model:route.model,context};return r;
}
