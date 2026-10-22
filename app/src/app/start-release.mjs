// Explicit operator opt-in for environments without one-off command access.
// This opt-in app-migration runner is disabled by default. AUTO_MIGRATE
// controls the separate legacy database baseline path in api/server.mjs.
if(process.env.AIRANK_RUN_APP_MIGRATIONS==='true'){
 const {getDb}=await import('../common/db.mjs');
 const {migrateApp}=await import('./migration.mjs');
 const {migrateProjectScans}=await import('./scan-migration.mjs');
 const {migrateMonitoring}=await import('../monitoring/migration.mjs');
  const {migrateResearch}=await import('../research/migration.mjs');
  const {migrateScheduling}=await import('../scheduling/migration.mjs');
  const {migrateOpportunities}=await import('../opportunities/migration.mjs');
  const {migrateReports}=await import('../reports/migration.mjs');
  const {migrateWebsiteProfiles}=await import('../website-profile/migration.mjs');
  const {migrateContextDrafts}=await import('../common/context-migration.mjs');
  const {migrateEmailAuth}=await import('./email-migration.mjs');
  const {migratePublicCheck}=await import('../public-check/migration.mjs');
 const {migrateSentiment}=await import('../sentiment/migration.mjs');
 const {migrateDailyScheduling}=await import('../scheduling/daily-migration.mjs');
 const {migrateCollectors}=await import('../collectors/migration.mjs');
 const {migrateIntelligence}=await import('../intelligence/migration.mjs');
 const {migrateImmediate}=await import('../monitoring/immediate-migration.mjs');
 const {migrateApiBudget}=await import('../monitoring/budget-migration.mjs');
 const {migrateSuggestions}=await import('../monitoring/suggestions-migration.mjs');
 const db=await getDb();
 await migrateApp(db);
 await migrateProjectScans(db);
 await migrateMonitoring(db);
  await migrateResearch(db);
  await migrateScheduling(db);
  await migrateOpportunities(db);
  await migrateReports(db);
  await migrateWebsiteProfiles(db);
  await migrateContextDrafts(db);
  await migrateEmailAuth(db);
  await migratePublicCheck(db);
  await migrateSentiment(db);
  await migrateDailyScheduling(db);
  await migrateCollectors(db);
  await migrateIntelligence(db);
  await migrateImmediate(db);
  await migrateApiBudget(db);
  await migrateSuggestions(db);
  const {migrateContent}=await import('../content/migration.mjs');
  await migrateContent(db);
  console.log('AI Rank app migrations 001–019 verified successfully.');
}
try {
 const {getDb}=await import('../common/db.mjs');
 const {emailAuthConfiguration}=await import('./email-auth.mjs');
 console.log(JSON.stringify({event:'email_auth_configuration',...await emailAuthConfiguration(await getDb())}));
} catch { console.log(JSON.stringify({event:'email_auth_configuration',available:false,database_ready:false})); }
await import('../api/server.mjs');
