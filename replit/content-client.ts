// Adapt base to the existing SAME-ORIGIN authenticated proxy. Never call a worker from the browser.
export type Locale = 'en' | 'fi';
export type JobKind = 'import'|'sitemap'|'audit'|'research'|'rewrite'|'create'|'opportunities'|'perception'|'impact'|'publish';
export type JobState = 'queued'|'running'|'completed'|'failed'|'cancelled'|'uncertain';
export interface ContentDocument {id:string;version:number;title:string;description:string;markdown:string;locale:Locale;status:'draft'|'in_review'|'approved'|'changes_requested';sourceUrl:string|null;reviewedClaims:boolean;updatedAt:number}
export interface ContentJob {id:string;kind:JobKind;status:JobState;input:Record<string,unknown>;checkpoint:Record<string,unknown>;result:unknown;error:string|null}
export class ContentError extends Error {constructor(public status:number,public code:string){super(code);}}
export function contentClient(projectId:string,csrf:()=>string,base='/api/airank/v1'){
 const prefix=base+'/projects/'+encodeURIComponent(projectId)+'/content';
 async function request<T>(method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(prefix+path,{method,credentials:'same-origin',headers:{...(method!=='GET'?{'Content-Type':'application/json','X-CSRF-Token':csrf()}: {})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const payload=await response.json();if(!response.ok)throw new ContentError(response.status,payload.error?.code||'REQUEST_FAILED');return payload;
 }
 return {
  overview:()=>request<any>('GET',''),
  documents:()=>request<ContentDocument[]>('GET','/documents'),
  document:(id:string)=>request<ContentDocument>('GET','/documents/'+encodeURIComponent(id)),
  create:(input:Pick<ContentDocument,'title'|'description'|'markdown'|'locale'>)=>request<ContentDocument>('POST','/documents',input),
  save:(id:string,expectedVersion:number,changes:Partial<ContentDocument>)=>request<ContentDocument>('PATCH','/documents/'+encodeURIComponent(id),{...changes,expectedVersion}),
  submit:(kind:JobKind,input:Record<string,unknown>,submissionId:string)=>request<ContentJob>('POST','/jobs',{kind,input,submissionId}),
  job:(id:string)=>request<ContentJob>('GET','/jobs/'+encodeURIComponent(id)),
  jobs:()=>request<ContentJob[]>('GET','/jobs'),
  cancel:(id:string)=>request<ContentJob>('POST','/jobs/'+encodeURIComponent(id)+'/cancel',{}),
  retry:(id:string)=>request<ContentJob>('POST','/jobs/'+encodeURIComponent(id)+'/retry',{}),
  apply:(id:string,expectedVersion:number,jobId:string,changeIds?:string[])=>request<ContentDocument>('POST','/documents/'+encodeURIComponent(id)+'/apply',{expectedVersion,jobId,changeIds}),
  review:(id:string,expectedVersion:number,status:string,factsChecked=false,note='')=>request<ContentDocument>('POST','/documents/'+encodeURIComponent(id)+'/review',{expectedVersion,status,factsChecked,note}),
  export:(id:string)=>request<{markdown:string;html:string;plainText:string;structuredDataSuggestion:unknown}>('GET','/documents/'+encodeURIComponent(id)+'/export'),
  request,
 };
}
// Generate once per intended user action; persist with its body until acknowledged.
export const newSubmissionId=()=>crypto.randomUUID();
