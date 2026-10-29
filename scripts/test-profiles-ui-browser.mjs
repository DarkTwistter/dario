// Browser interaction test with local HTTP servers only. OAuth completion is stubbed.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (globalThis.Bun) throw new Error('Run this browser interaction test with Node');
const home = await mkdtemp(join(tmpdir(), 'dario-profile-ui-'));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.DARIO_PROFILE_ROOT = join(home, 'profiles');
delete process.env.DARIO_BROWSER_LAUNCHER;
const { saveNetworkProfile, loadNetworkProfile } = await import('../dist/account-profiles.js');
const { saveAccount } = await import('../dist/accounts.js');
const { profilesUiPage } = await import('../dist/profiles-ui.js');
const { openProfileBrowser } = await import('../dist/profile-browser.js');
const { handleAdminRequest } = await import('../dist/admin-api.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const seen = [];
const server = createServer(async (req, res) => {
  seen.push({ path: req.url, method: req.method });
  if (req.url === '/profiles/ui') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(profilesUiPage()); return; }
  if (req.url === '/admin/profiles/work/login' && req.headers.authorization === 'Bearer ui-admin') {
    await saveAccount({ alias: 'work', networkProfile: 'work', accessToken: 'stub-access', refreshToken: 'stub-refresh', expiresAt: Date.now() + 3600000, scopes: [], deviceId: 'stub-device', accountUuid: 'stub-account' });
    res.setHeader('content-type', 'application/json'); res.end('{"status":"added"}'); return;
  }
  if (!await handleAdminRequest(req, res, req.url, { adminTokenBuf: Buffer.from('ui-admin') })) res.writeHead(404).end();
});
await listen(server);
const serverPort = server.address().port;
const proxy = createServer((req, res) => {
  const target = new URL(req.url);
  // Never forward a browser request to the real internet in this test.
  if (target.hostname !== '127.0.0.1' || Number(target.port) !== serverPort) { res.writeHead(502).end(); return; }
  const outgoing = request(target, { method: req.method, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
  outgoing.on('error', () => res.writeHead(502).end()); req.pipe(outgoing);
});
proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Test Proxy\r\nConnection: close\r\n\r\n'));
await listen(proxy);
await saveNetworkProfile({ version: 1, alias: 'ui-harness', proxyUrl: `http://127.0.0.1:${proxy.address().port}`, enabled: true });
let browser;
async function waitFor(expression) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { if (await browser.evaluate(expression)) return; } catch { /* a navigation may replace the execution context */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('UI condition did not become true: ' + expression);
}
try {
  browser = await openProfileBrowser('ui-harness', 'https://ui-harness.invalid/', undefined, { headless: true });
  await browser.evaluate(`location.href='http://127.0.0.1:${serverPort}/profiles/ui';true`).catch(() => {});
  await waitFor('!!document.getElementById("adminToken")');
  await browser.evaluate(`document.getElementById('adminToken').value='wrong';document.getElementById('connection').requestSubmit();true`);
  await waitFor(`document.getElementById('connectionStatus').textContent.includes('Нет доступа')`);
  assert.equal(await browser.evaluate(`document.getElementById('profileFields').disabled`), true);
  await browser.evaluate(`document.getElementById('adminToken').value='ui-admin';document.getElementById('connection').requestSubmit();true`);
  await waitFor(`!document.getElementById('profileFields').disabled`);
  await browser.evaluate(`
    for(const [id,value] of Object.entries({alias:'work',proxyServer:'http://proxy.example:8080',proxyUser:'user@name',proxyPassword:'p@ss:#/word',email:'work@example.com',timeZone:'Europe/Berlin',locale:'en-US'}))document.getElementById(id).value=value;
    document.getElementById('profileForm').requestSubmit();true;
  `);
  await waitFor(`document.getElementById('formStatus').textContent.includes('Профиль создан')`);
  const policy = loadNetworkProfile('work');
  assert.equal(decodeURIComponent(new URL(policy.proxyUrl).password), 'p@ss:#/word');
  assert.equal(await browser.evaluate(`document.getElementById('proxyPassword').value`), '');
  assert.equal(await browser.evaluate(`document.getElementById('profiles').textContent.includes('p@ss')`), false);
  await browser.evaluate(`document.querySelectorAll('.profile').forEach(row=>{if(row.querySelector('.alias').textContent==='work')row.querySelector('.primary').click()});true`);
  await waitFor(`document.getElementById('actionStatus').textContent.includes('добавлен в пул')`);
  await browser.evaluate(`document.querySelectorAll('.profile').forEach(row=>{if(row.querySelector('.alias').textContent==='work')Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Отключить').click()});true`);
  await waitFor(`Array.from(document.querySelectorAll('.profile')).some(row=>row.querySelector('.alias').textContent==='work'&&row.textContent.includes('Отключён'))`);
  assert.equal(loadNetworkProfile('work').enabled, false);
  await browser.evaluate(`document.querySelectorAll('.profile').forEach(row=>{if(row.querySelector('.alias').textContent==='work')Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Настройки').click()});true`);
  await waitFor(`document.getElementById('alias').disabled`);
  assert.equal(await browser.evaluate(`document.getElementById('proxyServer').value`), '');
  await browser.evaluate(`document.getElementById('email').value='changed@example.com';document.getElementById('profileForm').requestSubmit();true`);
  await waitFor(`document.getElementById('formStatus').textContent==='Настройки сохранены.'`);
  assert.equal(loadNetworkProfile('work').proxyUrl, policy.proxyUrl);
  assert.equal(loadNetworkProfile('work').email, 'changed@example.com');
  await browser.evaluate(`document.getElementById('disconnect').click();true`);
  assert.equal(await browser.evaluate(`document.getElementById('profileFields').disabled`), true);
  console.log('PASS: real browser admin authentication, create profile, encoded proxy password, sign-in action, disable, edit without revealing credentials, disconnect');
} finally {
  browser?.close(); if (browser) await browser.closed;
  proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
}
