import {confirmedPrompts,containsName} from '../common/scan-profile.mjs';
import {contextCatalog,measurementContext} from '../common/measurement-context.mjs';
import {generateContextQuestions} from '../common/context-prompts.mjs';
import {fail} from '../monitoring/shared.mjs';
export const PUBLIC_METHODOLOGY='public-confirmed-mentions-v1';
export async function publicPrompts(profile,count,env,generate=generateContextQuestions){
 const context=measurementContext(profile),market=contextCatalog().markets.find(m=>m.code===context.market).name,c=profile.category_fi;
 let texts;
 if(context.market==='FI'&&context.language==='fi')texts=confirmedPrompts(profile,6);
 else if(context.language==='en')texts=[
  `Which providers or products fit a customer in ${market} who needs ${c}? Name concrete alternatives.`,
  `Which alternatives should a customer in ${market} compare for ${c}? Explain the differences.`,
  `Which providers or products would you suggest for ${c} for a customer in ${market}? Explain your choice and limitations.`,
  `Which alternatives best suit a small business in ${market} that needs ${c}?`,
  `Which options available to a customer in ${market} meet the need for ${c}, and how do their features differ?`,
  `Which alternatives for ${c} suit a customer in ${market} who prioritizes ease of use?`
 ];
 else{
  texts=await generate({brandName:profile.brand_name,aliases:profile.aliases,ownedDomains:[profile.domain],categoryFi:c},context,env);
 }
 if(!Array.isArray(texts)||texts.length!==6||new Set(texts).size!==6||texts.some(t=>typeof t!=='string'||t.length<8||t.length>1000||/[<>\r]/.test(t)||[profile.brand_name,...profile.aliases,profile.domain].some(n=>containsName(t,n))))fail(503,'AI_UNAVAILABLE');
 return {prompts:texts.slice(0,count),paid_calls:context.language==='en'||context.market==='FI'&&context.language==='fi'?0:1};
}
