// Run with Bun. Real TLS provider + independent authenticated HTTP and HTTPS CONNECT proxies.
// Every accepted provider socket must originate from the intended proxy; dead/missing proxies never fall back.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm,unlink,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
if (!globalThis.Bun) throw new Error('Run: bun test/integration/profile-proxy-network.mjs');
// Bun caches homedir at startup; launch the fixture process with its isolated HOME already set.
if (!process.env.DARIO_PROXY_NETWORK_HOME) {
 const isolated = await mkdtemp(join(tmpdir(),'dario-proxy-network-'));
 try {
  const result = spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,HOME:isolated,USERPROFILE:isolated,DARIO_PROXY_NETWORK_HOME:isolated},stdio:'inherit',timeout:30000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
 } finally { await rm(isolated,{recursive:true,force:true}); }
 process.exit(process.exitCode ?? 0);
}
const home = process.env.DARIO_PROXY_NETWORK_HOME;
Object.assign(process.env,{HOME:home,USERPROFILE:home,DARIO_REQUIRE_ACCOUNT_PROXY:'1',DARIO_IGNORE_CC_CREDENTIALS:'1'});
const certPath=join(home,'server.crt'), keyPath=join(home,'server.key');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyPath,'-out',certPath,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:api.anthropic.com,DNS:platform.claude.com,DNS:auth.openai.com,DNS:chatgpt.com,DNS:claude.ai,DNS:2ip.io'],{stdio:'ignore'});
const tls={key:await readFile(keyPath),cert:await readFile(certPath)};
const realFetch=globalThis.fetch;
// Trust this test's CA; production fetch retains its normal certificate validation.
globalThis.fetch=(input,init)=>realFetch(input,{...init,tls:{ca:tls.cert.toString()}});
const proxyPorts=new Map(), sockets=new Set(), requests=[], tunnels=[];
const jwt=name=>'e30.'+Buffer.from(JSON.stringify({sub:name})).toString('base64url')+'.sig';
const atA=jwt('a'),atB=jwt('b');
let direct=0, badAuth=0;
const provider=https.createServer(tls,async(req,res)=>{
 const source=proxyPorts.get(req.socket.remotePort);
 if (!source) direct++;
 requests.push({source,path:req.url,auth:req.headers.authorization});
 const chunks=[];for await (const chunk of req) chunks.push(chunk);
 if(req.url.includes('/token')) {
  const isB=req.headers.host.startsWith('auth.openai.com');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:isB?atB:atA,refresh_token:isB?'refresh-b':'refresh-a',expires_in:3600,scope:'user:inference'}));
 }else if(req.headers.host==='2ip.io'){
  res.setHeader('Content-Type','text/plain');res.end('203.0.113.42\n');
 }else if(req.url==='/api/oauth/profile'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({account:{uuid:'a'},organization:{uuid:'org'}}));
 }else if(req.url==='/redirect'){res.writeHead(302,{Location:'https://chatgpt.com/redirect-finish'});res.end();
 }else if(req.url==='/stream'){
  res.setHeader('Content-Type','text/event-stream');res.write('data: first\n\n');setTimeout(()=>res.end('data: last\n\n'),15);
 }else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,models:[{slug:'gpt-test',visibility:'list'}]}));}
});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const targetPort=await listen(provider);
function proxy(server,name,user,password){
 server.on('connect',(req,client,head)=>{
  sockets.add(client);client.on('close',()=>sockets.delete(client));client.on('error',()=>{});
  const expected='Basic '+Buffer.from(user+':'+password).toString('base64');
  if(req.headers['proxy-authorization']!==expected){badAuth++;client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');return;}
  tunnels.push({name,target:req.url});
  const upstream=net.connect(targetPort,'127.0.0.1',()=>{
   proxyPorts.set(upstream.localPort,name);
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)upstream.write(head);
   upstream.pipe(client);client.pipe(upstream);
  });
  sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());
 });
 return server;
}
const httpProxy=proxy(http.createServer(),'a','alice','p:ass-a');
const httpsProxy=proxy(https.createServer(tls),'b','bob','p@ss-b');
const aPort=await listen(httpProxy),bPort=await listen(httpsProxy);
try{
 const profiles=await import('../../dist/account-proxy.js');
 const {completeAddAccount,refreshAccountToken}=await import('../../dist/accounts.js');
 const {completeAddCodexAccount,refreshCodexAccount}=await import('../../dist/codex-accounts.js');
 await profiles.createProxyProfile('claude','a',`http://alice:p%3Aass-a@127.0.0.1:${aPort}`);
 await profiles.createProxyProfile('codex','b',`https://bob:p%40ss-b@127.0.0.1:${bPort}`);
 const [a,b]=await Promise.all([completeAddAccount('a','code-a','verifier-a','state'),completeAddCodexAccount('b','code-b','verifier-b')]);
 assert.equal(requests.filter(r=>r.path==='/api/oauth/profile').length,1);
 await Promise.all([refreshAccountToken(a),refreshCodexAccount(b)]);
 await profiles.testProxyProfile('claude','a');await profiles.testProxyProfile('codex','b');
 process.env.CURL_CA_BUNDLE=certPath;process.env.NO_PROXY='*';process.env.no_proxy='*';
 // Trust the fixture CA for both the HTTPS target and HTTPS proxy, never disable TLS verification.
 const realCurl=execFileSync('sh',['-c','command -v curl'],{encoding:'utf8'}).trim();
 const curlBin=join(home,'bin');await mkdir(curlBin);
 const quote=value=>"'"+value.replace(/'/g,"'\"'\"'")+"'";
 await writeFile(join(curlBin,'curl'),'#!/bin/sh\nexec '+quote(realCurl)+' -q --proxy-cacert '+quote(certPath)+' "$@"\n',{mode:0o700});
 process.env.PATH=curlBin+':'+process.env.PATH;
 const ip=await profiles.testProxyProfileIp('claude','a');
 assert.equal(ip.curl_exit_code,0,ip.error);assert.equal(ip.observed_ip,'203.0.113.42');
 assert.ok(requests.some(r=>r.source==='a'&&r.path==='/'));
 const otherIp=await profiles.testProxyProfileIp('codex','b');
 assert.equal(otherIp.curl_exit_code,0,otherIp.error);assert.equal(otherIp.observed_ip,'203.0.113.42');


 await Promise.all(Array.from({length:20},(_,i)=>fetch(i%2?'https://api.anthropic.com/v1/messages':'https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer '+(i%2?atA:atB)}}).then(r=>r.json())));
 const streamed=await fetch('https://api.anthropic.com/stream',{headers:{Authorization:'Bearer '+atA}});
 assert.match(await streamed.text(),/data: first[\s\S]*data: last/);
 const redirected=await fetch('https://api.anthropic.com/redirect',{headers:{Authorization:'Bearer '+atA}});assert.equal((await redirected.json()).source,'a');
 assert.equal(requests.find(r=>r.path==='/redirect-finish').source,'a');
 const {fetchCodexModels,seedCodexUsage}=await import('../../dist/codex-backend.js');
 assert.deepEqual(await fetchCodexModels(b),['gpt-test']);await seedCodexUsage(b);
 assert.equal(direct,0);assert.equal(badAuth,0);assert.ok(tunnels.some(t=>t.name==='a'));assert.ok(tunnels.some(t=>t.name==='b'));
 for(const req of requests){if(req.auth==='Bearer '+atA)assert.equal(req.source,'a');if(req.auth==='Bearer '+atB)assert.equal(req.source,'b');}
 assert.ok(requests.some(r=>r.path==='/v1/oauth/token'&&r.source==='a'));
 assert.ok(requests.some(r=>r.path==='/oauth/token'&&r.source==='b'));
 const before=requests.length;
 await assert.rejects(fetch('https://api.anthropic.com/v1/messages'),/no account proxy/);
 assert.equal(requests.length,before);
 for(const socket of sockets)socket.destroy();
 await new Promise(resolve=>httpProxy.close(resolve));
 await assert.rejects(fetch('https://api.anthropic.com/v1/messages',{headers:{Authorization:'Bearer '+atA},signal:AbortSignal.timeout(2000)}),/Direct connection is disabled/);
 assert.equal(requests.length,before);assert.equal(direct,0);
 const failedIp=await profiles.testProxyProfileIp('claude','a');
 assert.notEqual(failedIp.curl_exit_code,0);assert.equal(failedIp.observed_ip,null);
 assert.equal(requests.length,before);assert.equal(direct,0);
 // The other profile remains usable even after the first proxy dies.
 assert.equal((await fetch('https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer '+atB}})).status,200);
 await unlink(join(home,'.dario','proxy-profiles','codex.b.json'));
 const after=requests.length;
 await assert.rejects(fetch('https://chatgpt.com/backend-api/codex/responses',{headers:{Authorization:'Bearer '+atB}}),/Create proxy profile/);
 assert.equal(requests.length,after);assert.equal(direct,0);
 console.log(`PASS real HTTP/HTTPS CONNECT: ${requests.length} provider requests, separate authenticated proxies, OAuth/identity/refresh/models/usage/streaming, dead and missing proxy fail closed; direct requests = ${direct}`);
}finally{
 for(const socket of sockets)socket.destroy();
 for(const server of [httpProxy,httpsProxy,provider]){server.closeAllConnections?.();server.close();}
 globalThis.fetch=realFetch;await rm(home,{recursive:true,force:true});
}
