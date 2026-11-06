// An empty admin-mode proxy serves a usable page while readiness stays truthful.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { freePort } from './helpers/free-port.mjs';

const home = await mkdtemp(join(tmpdir(), 'dario-home-ui-'));
Object.assign(process.env, { HOME:home, USERPROFILE:home, DARIO_ADMIN:'1', DARIO_ADMIN_TOKEN:'test-admin', DARIO_IGNORE_CC_CREDENTIALS:'1', DARIO_CODEX_USAGE_POLL_MS:'0' });
const { startProxy } = await import('../dist/proxy.js');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
try {
  await startProxy({port, host:'127.0.0.1', apiKey:'test-proxy', noLiveCapture:true, fetchImpl:async () => { throw new Error('Unexpected upstream request'); }});
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.match(html, /Код авторизации/);
  assert.match(html, /ChatGPT \/ Codex/);
  assert.ok(!html.includes('test-admin'));
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const head = await fetch(base, {method:'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const health = await fetch(base + '/health');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).status, 'degraded');
  assert.equal((await fetch(base + '/livez')).status, 200);
  assert.equal((await fetch(base + '/admin/accounts')).status, 401);
  const accounts = await fetch(base + '/admin/accounts', {headers:{Authorization:'Bearer test-admin'}});
  assert.equal(accounts.status, 200);
  assert.equal((await accounts.json()).count, 0);
  console.log('PASS: public setup page, syntax, HEAD, liveness, readiness and admin authentication');
  await rm(home, {recursive:true,force:true});
  process.exit(0);
} catch (error) {
  console.error(error);
  await rm(home, {recursive:true,force:true});
  process.exit(1);
}
