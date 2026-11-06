import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home=await mkdtemp(join(tmpdir(),'dario-admin-profiles-'));
Object.assign(process.env,{HOME:home,USERPROFILE:home,DARIO_REQUIRE_ACCOUNT_PROXY:'1',DARIO_IGNORE_CC_CREDENTIALS:'1'});
globalThis.Bun={version:'1.4.4'};
const originalFetch=globalThis.fetch;
let requests=0;
globalThis.fetch=async(url,init)=>{requests++;assert.deepEqual(init.proxy,{url:'http://alice:secret@proxy.invalid:8080/',respectNoProxy:false});return new Response(null,{status:200});};
try{
 const {handleAdminRequest}=await import('../dist/admin-api.js');
 async function call(path,body,token='admin',method=body===undefined?'GET':'POST'){
  const req=new EventEmitter();req.method=method;req.url=path;req.headers=token?{authorization:'Bearer '+token}:{};req.socket={remoteAddress:'127.0.0.1'};req.destroy=()=>{};
  setImmediate(()=>{if(body!==undefined)req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});
  const res={status:0,body:'',writeHead(status){this.status=status;},end(body){this.body=body;}};
  assert.equal(await handleAdminRequest(req,res,path,{adminTokenBuf:Buffer.from('admin')}),true);
  return {status:res.status,json:JSON.parse(res.body)};
 }
 assert.equal((await call('/admin/profiles',undefined,'wrong')).status,401);
 assert.equal((await call('/admin/profiles',{provider:'claude',alias:'a',proxy_url:'http://alice:secret@proxy.invalid:8080'},'wrong')).status,401);
 assert.equal((await call('/admin/profiles/ip',{provider:'claude',alias:'a'},'wrong')).status,401);
 assert.equal((await call('/admin/profiles/ip',undefined,'admin','GET')).status,405);
 assert.equal((await call('/admin/profiles/ip',{provider:'claude',alias:'missing'})).status,400);
 assert.deepEqual((await call('/admin/profiles')).json.profiles,[]);
 assert.equal((await call('/admin/login/start',{alias:'a'})).status,400);
 assert.equal((await call('/admin/codex/login/start',{alias:'a'})).status,400);
 assert.equal(requests,0);
 const created=await call('/admin/profiles',{provider:'claude',alias:'a',proxy_url:'http://alice:secret@proxy.invalid:8080'});
 assert.equal(created.status,201);assert.equal(created.json.profile.alias,'a');assert.equal(created.json.profile.authentication,true);
 assert.ok(!JSON.stringify(created).includes('secret'));assert.ok(!JSON.stringify(created).includes('alice'));
 assert.equal((await call('/admin/profiles',{provider:'claude',alias:'a',proxy_url:'http://different.invalid:80'})).status,400);
 assert.equal((await call('/admin/profiles')).json.profiles[0].proxy,'http://proxy.invalid:8080');
 assert.equal((await call('/admin/profiles/test',{provider:'claude',alias:'a'})).status,200);assert.equal(requests,1);
 const started=await call('/admin/login/start',{alias:'a'});
 assert.equal(started.status,200);assert.ok(started.json.authorize_url);
 assert.equal((await call('/admin/profiles',{provider:'other',alias:'b',proxy_url:'http://proxy'})).status,400);
 assert.equal((await call('/admin/profiles',undefined,'admin','DELETE')).status,405);
 console.log('PASS admin profiles: authentication, profile-first login, private credentials, immutable binding, test through profile proxy');
}finally{globalThis.fetch=originalFetch;delete globalThis.Bun;await rm(home,{recursive:true,force:true});}
