import {mkdirSync,chownSync,chmodSync} from 'node:fs';
import {createApp} from './server.mjs';
const dir=process.env.DATA_DIR||'/data';
try {
  if(process.getuid?.()===0){mkdirSync(dir,{recursive:true,mode:0o700});chownSync(dir,1000,1000);chmodSync(dir,0o700);process.setgroups([]);process.setgid(1000);process.setuid(1000);}
  const app=createApp(process.env);
  app.server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('AI Rank Google Connector 0.2.0 listening'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{app.stop();app.server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();});
}catch(e){console.error('Startup failed: '+e.message);process.exit(1);}
