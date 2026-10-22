import {instructions,validateEntities} from './core.mjs';
export const schema={type:'object',additionalProperties:false,required:['complete','brands'],properties:{complete:{type:'boolean'},brands:{type:'array',items:{type:'object',additionalProperties:false,required:['name','kind','ambiguous','quotes'],properties:{name:{type:'string'},kind:{type:'string',enum:['company','product']},ambiguous:{type:'boolean'},quotes:{type:'array',items:{type:'string'}}}}}}};
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function analyse(e,c,{env=process.env,fetcher=fetch}={}){
 if(!env.OPENAI_API_KEY)fail('MISSING_CREDENTIAL');
 const r=await fetcher('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(c.timeoutMs),body:JSON.stringify({model:c.model,temperature:0,max_completion_tokens:6000,store:false,response_format:{type:'json_schema',json_schema:{name:'brand_entities',strict:true,schema}},messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({answer:e.answer})}]})});
 if(!r.ok){await r.body?.cancel();fail(`ENTITY_HTTP_${r.status}`);}
 const parts=[];let size=0;
 if(!r.body)fail('ENTITY_EMPTY_RESPONSE');
 for await(const part of r.body){size+=part.length;if(size>500000)fail('ENTITY_RESPONSE_TOO_LARGE');parts.push(Buffer.from(part));}
 let data,output;try{data=JSON.parse(Buffer.concat(parts).toString());}catch{fail('ENTITY_INVALID_JSON');}
 const choice=data.choices?.[0];
 if(choice?.finish_reason!=='stop'||choice.message?.refusal)fail('ENTITY_INCOMPLETE');
 try{output=JSON.parse(choice.message.content);}catch{fail('ENTITY_INVALID_JSON');}
 const parsed=validateEntities(output,e);
 return {...parsed,requestedModel:c.model,model:data.model,usage:data.usage||{},assessedAt:Date.now()};
}
