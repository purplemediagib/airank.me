import test from 'node:test';
import assert from 'node:assert/strict';
import { toHostname, isPublicIP, hashToken, randomToken, eqString, parseCookie } from '../src/common/utils.mjs';
import { pkceChallenge, createOauthRequest } from '../src/common/google.mjs';
import { detectEvidence, promptCandidates } from '../src/common/observations.mjs';
import { summariseWebsite } from '../src/common/fetch-website.mjs';

const badUrls=['127.0.0.1','localhost','http://192.168.1.5','http://metadata.google.internal','ftp://example.fi','http://example.fi:9000','https://user:pass@example.fi','[::1]','foo.onion'];
for(const x of badUrls)test('rejects unsafe website URL: '+x,()=>assert.throws(()=>toHostname(x)));
for(const x of ['https://www.example.fi/path','example.fi','HTTP://EXAMPLE.FI'])test('normalizes '+x,()=>assert.equal(toHostname(x),x.startsWith('https://www')?'www.example.fi':'example.fi'));
test('public IP checks prevent SSRF to common restricted networks',()=>{
 for(const x of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.2.3','192.168.0.3','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(isPublicIP(x),false,x);
 for(const x of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicIP(x),true,x);
});
test('PKCE SHA256 challenge and OAuth query parameters',()=>{
 assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
 const url=new URL(createOauthRequest({clientId:'test',redirectUri:'https://api.airank.me/v1/auth/google/callback',nonce:'nonce',state:'state',verifier:'verifier'}));
 assert.equal(url.hostname,'accounts.google.com');assert.equal(url.searchParams.get('scope'),'openid email profile');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
});
test('session tokens are random, hashed, constant-time compared',()=>{const x=randomToken(),y=randomToken();assert.notEqual(x,y);assert.notEqual(hashToken(x),x);assert.equal(eqString(hashToken(x),hashToken(x)),true);assert.equal(eqString(hashToken(x),hashToken(y)),false)});
test('cookie parser',()=>assert.deepEqual(parseCookie('airank_oauth_state=abc; other=hello%20you'),{airank_oauth_state:'abc',other:'hello you'}));
test('website parser derives name with no HTML scripts',()=>{
 const r=summariseWebsite('<head><title>Accounting | Example Oy</title><meta property="og:site_name" content="Example Oy"><meta name="description" content="Tilitoimisto Helsingissä"></head><body><h1>Kirjanpito</h1><script>doEvil()</script></body>','example.fi');
 assert.equal(r.brand,'Example Oy');assert.equal(r.h1,'Kirjanpito');assert.ok(!r.body.includes('doEvil'));
});
test('Finnish prompt templates do not pre-mention target brand/domain',()=>{
 const x=promptCandidates({brand:'Example Oy',description:'Example Oy tarjoaa kirjanpitopalveluita Suomessa',domain:'example.fi'},3);
 assert.equal(x.length,3);assert.ok(x.every(s=>!s.includes('Example Oy')&&!s.includes('example.fi')&&s.endsWith('?')));
});
test('mentions and citations are distinct',()=>{
 const a=detectEvidence('Kokeile Example Oy palvelua.', 'Example Oy','example.fi',[{url:'https://example.fi/guide'}]);
 assert.equal(a.mentioned,true);assert.equal(a.ownCitation,true);
 const b=detectEvidence('Valitse toinen palvelu','Example Oy','example.fi',[{url:'https://news.fi/story'}]);
 assert.equal(b.mentioned,false);assert.equal(b.ownCitation,false);
 const c=detectEvidence('Airlines are useful','Air','air.fi',[]);assert.equal(c.mentioned,false);
});
test('neutral mention does not automatically count as recommendation',()=>{
 const a=detectEvidence('Example Oy sijaitsee Helsingissä.', 'Example Oy','example.fi',[]);assert.equal(a.recommended,false);
});
