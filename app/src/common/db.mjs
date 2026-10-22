let client;
export async function getDb(){
  if (client) return client;
  if(!process.env.BUNNY_DATABASE_URL || !process.env.BUNNY_DATABASE_AUTH_TOKEN) throw new Error('Bunny Database not linked yet');
  const { createClient }= await import('@libsql/client/web');
  client=createClient({url:process.env.BUNNY_DATABASE_URL,authToken:process.env.BUNNY_DATABASE_AUTH_TOKEN});
  return client;
}
export async function sql(statement,args=[]){const db=await getDb();return db.execute({sql:statement,args})}
export async function one(statement,args=[]){const r=await sql(statement,args);return r.rows?.[0]||null}
export async function scalar(statement,args=[]){const r=await one(statement,args);return r?Object.values(r)[0]:null}
