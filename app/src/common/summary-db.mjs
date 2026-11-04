import {createSummaryDatabase} from '../analytics/summary-transport.mjs';
let client;
// Dedicated saved-analytics transport; other APIs retain their existing client.
export function getSummaryDb(){
 return client ||= createSummaryDatabase({url:process.env.BUNNY_DATABASE_URL,authToken:process.env.BUNNY_DATABASE_AUTH_TOKEN});
}
