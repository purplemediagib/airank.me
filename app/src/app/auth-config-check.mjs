// Read-only readiness check. Never print configuration values or credentials.
import {getDb} from '../common/db.mjs';
import {emailAuthConfiguration} from './email-auth.mjs';
try {
  const config=await emailAuthConfiguration(await getDb());
  console.log(JSON.stringify({event:'email_auth_configuration',...config}));
  process.exitCode=config.available?0:1;
} catch {
  console.log(JSON.stringify({event:'email_auth_configuration',available:false,database_ready:false}));
  process.exitCode=1;
}
