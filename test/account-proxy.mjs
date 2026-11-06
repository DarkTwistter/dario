// Concurrent account actions must retain their own proxy, including OAuth before token persistence.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = await mkdtemp(join(tmpdir(), 'dario-account-proxy-'));
Object.assign(process.env, {HOME:home, USERPROFILE:home, DARIO_REQUIRE_ACCOUNT_PROXY:'1', DARIO_IGNORE_CC_CREDENTIALS:'1', DARIO_OAUTH_TOKEN_URL:'https://platform.claude.com/mock-token', DARIO_CODEX_TOKEN_URL:'https://auth.openai.com/mock-token'});
// This suite inspects fetch options. The real runtime/proxy socket contract is tested in integration/profile-proxy-network.mjs.
const savedFetch = globalThis.fetch;
globalThis.Bun = {};
const calls = [];
let fail = false;
const jwt = name => 'e30.' + Buffer.from(JSON.stringify({sub:name})).toString('base64url') + '.sig';
const claudeToken = jwt('claude'), codexToken = jwt('codex');
globalThis.fetch = async (url, init) => {
  calls.push({url:String(url), proxy:init?.proxy, authorization:new Headers(init?.headers).get('authorization'), body:String(init?.body ?? '')});
  if (fail) throw new Error('network error at http://private-user:private-password@proxy');
  const isCodex = String(url).includes('openai.com');
  if (String(url).endsWith('mock-token')) return Response.json({access_token:isCodex?codexToken:claudeToken,refresh_token:isCodex?'codex-refresh':'claude-refresh',expires_in:3600,scope:'user:inference'});
  if (String(url).includes('/models')) return Response.json({models:[{slug:'gpt-test',visibility:'list'}]});
  return Response.json({account:{uuid:'test'},organization:{uuid:'org'}});
};
try {
  const profiles = await import('../dist/account-proxy.js');
  const {startAddAccount, completeAddAccount, refreshAccountToken} = await import('../dist/accounts.js');
  const {startAddCodexAccount, completeAddCodexAccount, refreshCodexAccount} = await import('../dist/codex-accounts.js');
  const proxyA = 'http://alice:password-a@proxy-a.invalid:8080/';
  const proxyB = 'https://bob:password-b@proxy-b.invalid:8443/';
  await assert.rejects(startAddAccount('missing'),/Create proxy profile/);
  await assert.rejects(startAddCodexAccount('missing'),/Create proxy profile/);
  assert.equal(calls.length,0);
  const a = await profiles.createProxyProfile('claude','a',proxyA);
  const b = await profiles.createProxyProfile('codex','b',proxyB);
  assert.equal((await stat(join(home,'.dario','proxy-profiles','claude.a.json'))).mode & 0o777,0o600);
  const visible = JSON.stringify((await profiles.listProxyProfiles()).map(profiles.publicProxyProfile));
  for (const secret of ['alice','password-a','bob','password-b']) assert.ok(!visible.includes(secret));
  await assert.rejects(profiles.createProxyProfile('claude','a',proxyB),/immutable/);
  await assert.rejects(profiles.createProxyProfile('claude','../bad',proxyA),/Invalid profile/);
  await assert.rejects(profiles.createProxyProfile('claude','bad','socks5://alice:password-a@proxy'),error=>!error.message.includes('password-a'));
  const [claude,codex] = await Promise.all([completeAddAccount('a','code','verifier','state'),completeAddCodexAccount('b','code','verifier')]);
  assert.ok(calls.length >= 3);
  for (const call of calls) assert.equal(call.proxy,call.url.includes('openai.com')?proxyB:proxyA);
  calls.length=0;
  await Promise.all([refreshAccountToken(claude),refreshCodexAccount(codex)]);
  assert.equal(calls.length,2);
  for (const call of calls) assert.equal(call.proxy,call.url.includes('openai.com')?proxyB:proxyA);
  calls.length=0;
  await Promise.all(Array.from({length:40},(_,index) => index%2
    ? profiles.withAccountProxy('claude','a',async()=>{await new Promise(r=>setTimeout(r,index%5));return fetch('https://api.anthropic.com/v1/messages',{headers:{Authorization:'Bearer '+claudeToken}});})
    : profiles.withAccountProxy('codex','b',async()=>{await new Promise(r=>setTimeout(r,index%5));return fetch('https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer '+codexToken}});})));
  assert.equal(calls.length,40);
  for (const call of calls) assert.equal(call.proxy,call.authorization.includes(codexToken)?proxyB:proxyA);
  calls.length=0;
  // Models and usage run in timers with no request context; persisted credentials still bind them.
  const {fetchCodexModels,seedCodexUsage}=await import('../dist/codex-backend.js');
  assert.deepEqual(await fetchCodexModels(codex),['gpt-test']);
  await seedCodexUsage(codex);
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.proxy===proxyB));
  calls.length=0;
  // An ambient context cannot send another account's bearer over its own proxy.
  await profiles.withAccountProxy('claude','a',()=>fetch('https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer '+codexToken},proxy:proxyA}));
  assert.equal(calls[0].proxy,proxyB);
  // Legacy global proxy defaults cannot replace a profile binding.
  const {installOutboundProxyWrapper,parseOutboundProxy}=await import('../dist/outbound-proxy.js');
  installOutboundProxyWrapper(parseOutboundProxy('http://global.invalid:9090'));
  await fetch('https://api.anthropic.com/v1/messages',{headers:{Authorization:'Bearer '+claudeToken}});
  assert.equal(calls.at(-1).proxy,proxyA);
  calls.length=0;
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages'),/no account proxy/);
  await assert.rejects(fetch('https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer unknown'}}),/no account proxy/);
  assert.equal(calls.length,0);
  fail=true;
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages',{headers:{Authorization:'Bearer '+claudeToken}}),error=>/Direct connection is disabled/.test(error.message)&&!error.message.includes('private-password'));
  assert.equal(calls.length,1); // No second/direct attempt.
  fail=false;
  await unlink(join(home,'.dario','proxy-profiles','claude.a.json'));
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages',{headers:{Authorization:'Bearer '+claudeToken}}),/Create proxy profile/);
  const before=calls.length;
  await assert.rejects(completeAddAccount('a','code','verifier','state'),/Create proxy profile/);
  assert.equal(calls.length,before);
  delete globalThis.Bun;
  await assert.rejects(profiles.withAccountProxy('codex','b',()=>fetch('https://auth.openai.com/token')),/require Bun|Refusing/);
  console.log('PASS account proxy: profile first, secret redaction, OAuth and identity, refresh, 40 concurrent requests, models, usage, global proxy precedence, missing/dead proxy, no direct fallback, Node refusal');
} finally {globalThis.fetch=savedFetch;delete globalThis.Bun;await rm(home,{recursive:true,force:true});}
