// Offline only. Fresh SQLite connection per synthetic HTTP request; no sockets/fetch.
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
export function fixture({clockSQL}={}){
 const dir=mkdtempSync(new URL('./fixture-',import.meta.url).pathname),path=join(dir,'synthetic.sqlite');
 let now=Date.now(),calls=0,hook=null,lose=false;
 const records=[];
 const condition=(c,r)=>!c?true:c.type==='ok'?r[c.step]!==null:c.type==='not'?!condition(c.cond,r):c.type==='and'?c.conds.every(x=>condition(x,r)):(()=>{throw Error('BAD_CONDITION');})();
 const encode=v=>v===null?{type:'null'}:typeof v==='string'?{type:'text',value:v}:{type:'integer',value:String(v)};
 const decode=v=>v.type==='null'?null:v.type==='integer'?Number(v.value):v.value;
 const f={get now(){return now;},set now(value){now=value;},get calls(){return calls;},records,setHook(fn){hook=fn;},loseNextResponse(){lose=true;},
  query(sql,...args){const c=new DatabaseSync(path);try{return c.prepare(sql).all(...args);}finally{c.close();}},
  close(){rmSync(dir,{recursive:true,force:true});},
  fetch:async request=>{
   calls++;const body=JSON.parse(await request.text());records.push(body);
   const c=new DatabaseSync(path);c.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');c.function('fixture_clock',()=>BigInt(now));
   function execute(stmt,index){
    hook?.({stmt,index,connection:c,fixture:f});
    const sql=clockSQL?stmt.sql.replaceAll(clockSQL,'fixture_clock()'):stmt.sql;
    const s=c.prepare(sql),args=(stmt.args||[]).map(decode);
    const rows=stmt.want_rows?s.all(...args):[];
    const affected=stmt.want_rows?c.prepare('SELECT changes() n').get().n:s.run(...args).changes;
    return {cols:stmt.want_rows?s.columns().map(x=>({name:x.name})):[],rows:rows.map(r=>Object.values(r).map(encode)),affected_row_count:Number(affected),last_insert_rowid:null};
   }
   let result;
   try{
    const op=body.requests[0];
    if(op.type==='execute'){
     try{result={type:'ok',response:{type:'execute',result:execute(op.stmt,0)}};}
     catch(e){result={type:'error',error:{code:'SQLITE_ERROR',message:e.message}};}
    }else{
     const steps=op.batch.steps,r=steps.map(()=>null),e=steps.map(()=>null);
     for(let i=0;i<steps.length;i++)if(condition(steps[i].condition,r))try{r[i]=execute(steps[i].stmt,i);}catch(error){e[i]={message:error.message,code:'SQLITE_ERROR'};}
     result={type:'ok',response:{type:'batch',result:{step_results:r,step_errors:e}}};
    }
   }finally{try{c.exec('ROLLBACK');}catch{}c.close();}
   if(lose){lose=false;throw Error('SIMULATED_LOST_RESPONSE');}
   return new Response(JSON.stringify({baton:null,base_url:'https://never-adopt.invalid/',results:[result,{type:'ok',response:{type:'close'}}]}),{status:200,headers:{'content-type':'application/json'}});
  }};
 return f;
}
