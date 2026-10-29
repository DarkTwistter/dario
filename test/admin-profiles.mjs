import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HOME = await mkdtemp(join(tmpdir(), 'dario-admin-profiles-'));
process.env.USERPROFILE = process.env.HOME;
process.env.DARIO_PROFILE_ROOT = join(process.env.HOME, 'profiles');
const { handleAdminRequest } = await import('../dist/admin-api.js');
const { loadNetworkProfile } = await import('../dist/account-profiles.js');
const { loadAccount, saveAccount } = await import('../dist/accounts.js');
let reloads = 0;
const audits = [];
const server = createServer(async (req, res) => {
  if (!await handleAdminRequest(req, res, req.url, {
    adminTokenBuf: Buffer.from('test-admin'), onAccountsChanged: () => { reloads++; }, audit: event => audits.push(event),
  })) res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (path, body, token = 'test-admin') => fetch(base + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  assert.equal((await call('/admin/profiles', undefined, 'wrong')).status, 401);
  const credentials = { alias: 'work', accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, scopes: [], deviceId: 'device', accountUuid: 'account' };
  await saveAccount(credentials);
  let response = await call('/admin/profiles', { alias: 'work', proxyUrl: 'http://username:secret@proxy.invalid:8080', locale: 'en-US' });
  assert.equal(response.status, 201);
  assert.equal(JSON.stringify(await response.json()).includes('secret'), false);
  assert.equal((await loadAccount('work')).networkProfile, 'work');
  assert.equal(reloads, 1);
  assert.equal((await call('/admin/profiles', { alias: 'work', proxyUrl: 'http://proxy.invalid' })).status, 409);
  response = await call('/admin/profiles');
  const listing = await response.json();
  assert.equal(listing.profiles.length, 1);
  assert.equal(listing.profiles[0].authenticated, true);
  assert.equal(listing.profiles[0].loginPending, false);
  assert.equal(JSON.stringify(listing).includes('username'), false);
  assert.equal(JSON.stringify(listing).includes('test-access'), false);
  assert.equal((await call('/admin/profiles/work/disable', {})).status, 200);
  assert.equal(loadNetworkProfile('work').enabled, false);
  assert.equal((await call('/admin/profiles/work/check', {})).status, 400, 'disabled profile never opens a check browser');
  assert.equal((await call('/admin/profiles/work/login', {})).status, 400, 'disabled profile never launches a browser');
  assert.equal((await call('/admin/profiles/missing/enable', {})).status, 404);
  assert.equal((await call('/admin/profiles/work/enable', {})).status, 200);
  assert.equal(loadNetworkProfile('work').enabled, true);
  response = await call('/admin/profiles/work/update', { email: 'work@example.com', timeZone: 'Europe/Berlin', locale: 'de-DE' });
  assert.equal(response.status, 200);
  assert.equal(loadNetworkProfile('work').proxyUrl, 'http://username:secret@proxy.invalid:8080', 'editing metadata preserves hidden proxy credentials');
  response = await call('/admin/profiles/work/update', { proxyUrl: 'http://newuser:newsecret@other.invalid:3128', timeZone: '', locale: '' });
  assert.equal(response.status, 200);
  assert.equal(loadNetworkProfile('work').proxyUrl, 'http://newuser:newsecret@other.invalid:3128');
  assert.equal(loadNetworkProfile('work').timeZone, undefined);
  assert.equal(JSON.stringify(await response.json()).includes('newsecret'), false);
  assert.equal((await call('/admin/profiles/work/update', { proxyUrl: 'socks5://host:1080' })).status, 400);
  assert.equal(loadNetworkProfile('work').proxyUrl, 'http://newuser:newsecret@other.invalid:3128', 'invalid settings do not clobber a working policy');
  response = await call('/admin/profiles', { alias: 'bad', proxyUrl: 'http://username:secret@host/path' });
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes('secret'), false);
  assert.equal((await call('/admin/profiles', { alias: '../escape', proxyUrl: 'http://host' })).status, 400);
  assert.equal(JSON.stringify(audits).includes('secret'), false);
  console.log('PASS: admin profile authentication, protected creation, binding, hot reload, enable/disable, validation, redaction');
} finally { server.closeAllConnections(); server.close(); }
