import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = await mkdtemp(join(tmpdir(), 'dario-proxy-diag-'));
Object.assign(process.env, { HOME:home, USERPROFILE:home, DARIO_REQUIRE_ACCOUNT_PROXY:'1', DARIO_IGNORE_CC_CREDENTIALS:'1' });
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalPath = process.env.PATH;
globalThis.Bun = {version:'1.4.4'};
const logs = [];
console.info = (...parts) => logs.push(parts.join(' '));
const proxy = 'http://proxy-user:proxy-password@proxy.invalid:8080/';
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.equal(String(url), 'https://claude.ai/'); assert.equal(init.method, 'GET'); assert.deepEqual(init.proxy, {url:proxy,respectNoProxy:false});
  return new Response('Access denied. password=proxy-password', { status:403, headers:{'cf-ray':'test-ray', 'content-type':'text/plain', 'set-cookie':'session=hidden'} });
};
try {
  const profiles = await import('../dist/account-proxy.js');
  const { redactDiagnostic } = await import('../dist/proxy-diagnostics.js');
  const profile = await profiles.createProxyProfile('claude','check',proxy);
  const provider = await profiles.testProxyProfile('claude','check');
  assert.equal(provider.status,403);
  assert.equal(provider.diagnostic.proxy_reachable,true);
  assert.equal(provider.diagnostic.provider_accessible,false);
  assert.equal(provider.diagnostic.response.headers['cf-ray'],'test-ray');
  assert.equal(provider.diagnostic.response.headers['set-cookie'],undefined);
  assert.match(provider.diagnostic.response.body,/Access denied/);
  assert.equal(calls,1);
  assert.ok(!JSON.stringify(provider).includes('proxy-password'));
  assert.match(redactDiagnostic('Bearer private-token password=another-secret '+proxy,profile),/Bearer \[redacted\]/);
  const bin=join(home,'bin'); await mkdir(bin);
  const captured=join(home,'config.txt'); process.env.CURL_TEST_CAPTURE=captured;
  await writeFile(join(bin,'curl'),`#!/usr/bin/env node
const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['-q','--config','-']))process.exit(90);
fs.writeFileSync(process.env.CURL_TEST_CAPTURE,input);
if(!input.includes('noproxy = ""')||!input.includes('proxy = "${proxy}"')||!input.includes('url = "https://2ip.io/"')){console.error(JSON.stringify([input.includes('noproxy = ""'),input.includes('proxy = "${proxy}"'),input.includes('url = "https://2ip.io/"')]));process.exit(91);}
const marker=input.match(/--dario-[a-f0-9-]+--/)[0];
process.stdout.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\nHTTP/2 200\\r\\nContent-Type: text/plain\\r\\nSet-Cookie: secret=private\\r\\n\\r\\n203.0.113.42\\n\\n'+marker+'200|127.0.0.1|200');
});\n`,{mode:0o700});
  process.env.PATH=bin+':'+originalPath;
  process.env.NO_PROXY='*';
  const ip=await profiles.testProxyProfileIp('claude','check');
  assert.equal(ip.observed_ip,'203.0.113.42',JSON.stringify(ip));
  assert.equal(ip.curl_exit_code,0);
  assert.equal(ip.response.status,200);
  assert.equal(ip.response.headers['content-type'],'text/plain');
  assert.equal(ip.response.headers['set-cookie'],undefined);
  assert.equal(ip.request.url,'https://2ip.io/');
  assert.ok((await readFile(captured,'utf8')).includes('max-redirs = 0'));
  for(const secret of ['proxy-user','proxy-password','private-token','secret=private']) assert.ok(!logs.join('\n').includes(secret));
  assert.ok(logs.some(l=>l.includes(ip.trace_id)));
  console.log('PASS proxy diagnostics: truthful HTTP 403, redacted response, real curl command contract, stdin credentials, NO_PROXY override and egress IP parsing');
} finally {
  globalThis.fetch=originalFetch;console.info=originalInfo;delete globalThis.Bun;process.env.PATH=originalPath;await rm(home,{recursive:true,force:true});
}
