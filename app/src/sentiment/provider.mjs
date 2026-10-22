import {instructions,brandsFor,validateAssessments,rubricVersion} from './core.mjs';
export const schema={type:'object',additionalProperties:false,required:['assessments'],properties:{assessments:{type:'array',items:{type:'object',additionalProperties:false,required:['brandId','status','quotes'],properties:{brandId:{type:'string'},status:{type:'string',enum:['assessed','not_mentioned','unclassified']},quotes:{type:'array',items:{type:'object',additionalProperties:false,required:['text','polarity','attribute'],properties:{text:{type:'string'},polarity:{type:'string',enum:['strongly_negative','negative','neutral','positive','strongly_positive']},attribute:{type:'string'}}}}}}}}};
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function analyse(e,s,c,{env=process.env,fetcher=fetch,now=Date.now}={}){
 if(!env.OPENAI_API_KEY)fail('MISSING_CREDENTIAL');
 const response=await fetcher('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(c.timeoutMs),body:JSON.stringify({model:c.model,temperature:0,max_completion_tokens:8000,store:false,response_format:{type:'json_schema',json_schema:{name:'brand_sentiment',strict:true,schema}},messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({brands:brandsFor(s),language:s.language||'fi',question:e.text,answer:e.answer})}]})});
 if(!response.ok){try{await response.body?.cancel();}catch{}fail(`SENTIMENT_HTTP_${response.status}`);}
 const reader=response.body?.getReader();if(!reader)fail('INVALID_SENTIMENT_RESPONSE');
 let size=0;const parts=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>500000){await reader.cancel();fail('SENTIMENT_RESPONSE_TOO_LARGE');}parts.push(Buffer.from(value));}
 let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('INVALID_SENTIMENT_RESPONSE');}
 const choice=data.choices?.[0];
 if(choice?.message?.refusal)fail('SENTIMENT_REFUSED');
 if(choice?.finish_reason!=='stop')fail('SENTIMENT_INCOMPLETE');
 let output;try{output=JSON.parse(choice.message.content);}catch{fail('INVALID_SENTIMENT_OUTPUT');}
 const assessments=validateAssessments(output,e,s);
 const usage={};for(const k of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(data.usage?.[k])&&data.usage[k]>=0)usage[k]=data.usage[k];
 return {analysisVersion:c.version,rubricVersion,requestedModel:c.model,model:typeof data.model==='string'?data.model.slice(0,100):'unknown',assessedAt:now(),responseId:typeof data.id==='string'?data.id.slice(0,200):null,usage,assessments};
}
