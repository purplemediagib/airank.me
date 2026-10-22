export const CONFIG = {
  version: '0.22.0',
  appEnv: process.env.APP_ENV || 'staging',
  apiPort: Number(process.env.PORT || 3000),
  workerPort: Number(process.env.PORT || 3001),
  apiUrl: (process.env.API_URL || '').replace(/\/$/,''),
  appUrl: (process.env.APP_URL || 'https://app.airank.me').replace(/\/$/,''),
  webUrl: (process.env.WEB_URL || 'https://airank.me').replace(/\/$/,''),
  allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || 'https://app.airank.me,https://airank.me').split(',').map(s=>s.trim()).filter(Boolean),
  cookieName: process.env.COOKIE_SECURE === 'false' ? 'airank_session_dev' : '__Host-airank_session',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS || 14)),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  maxProviderCalls: Math.max(1, Number(process.env.MAX_PROVIDER_CALLS_PER_SCAN || 18)),
  maxDailyProviderCalls: Math.max(1, Number(process.env.MAX_DAILY_PROVIDER_CALLS || 200)),
  scanPrompts: Math.min(6,Math.max(1,Number(process.env.FREE_PROMPTS_PER_PROVIDER || 3))),
  jobPollMs: Math.max(5000,Number(process.env.JOB_POLL_SECONDS || 30)*1000),
  leaseMs: 30*60*1000,
  enabledProviders: (process.env.ENABLED_PROVIDERS || 'openai,claude').split(',').map(s=>s.trim()).filter(Boolean),
  httpTimeoutMs: Math.max(2000,Number(process.env.PROVIDER_TIMEOUT_SECONDS || 60)*1000),
};
export function hasDbConfig(){return !!(process.env.BUNNY_DATABASE_URL && process.env.BUNNY_DATABASE_AUTH_TOKEN)}
export function providerAvailable(p){
  if(p==='openai')return !!process.env.OPENAI_API_KEY;
  if(p==='claude')return !!process.env.ANTHROPIC_API_KEY;
  if(p==='gemini')return !!process.env.OPENROUTER_API_KEY;
  if(p==='grok')return !!process.env.XAI_API_KEY;
  if(p==='perplexity')return !!process.env.PERPLEXITY_API_KEY;
  if(p==='google_aio')return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  return false;
}
