import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const home = await mkdtemp(join(tmpdir(), 'dario-manual-profile-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.DARIO_PROFILE_ROOT = join(home, 'profiles');
process.env.DARIO_REQUIRE_ACCOUNT_PROXY = '1';
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
process.env.DARIO_OAUTH_CLIENT_ID = 'test-client';
process.env.DARIO_OAUTH_AUTHORIZE_URL = 'https://authorize.invalid/oauth/authorize';
process.env.DARIO_OAUTH_TOKEN_URL = 'https://token.invalid/token';
const { handleAdminRequest } = await import('../dist/admin-api.js');
const { saveNetworkProfile, loadNetworkProfile } = await import('../dist/account-profiles.js');
const { loadAccount } = await import('../dist/accounts.js');
const nativeFetch = globalThis.fetch;
const originalBun = globalThis.Bun;
// Stub only the external transport, inspecting the actual per-request proxy option.
// Node cannot route proxies; real Bun routing is covered by test-profile-bun-transport.mjs.
globalThis.Bun = {};
let exchanges = [], profileEmail = 'work@example.com', outage = false, reloads = 0;
const proxy = 'http://user:secret@proxy.invalid:8080';
globalThis.fetch = async (input, init) => {
  assert.equal(init.proxy, proxy);
  if (outage) throw new Error('synthetic proxy outage');
  if (String(input) === 'https://token.invalid/token') {
    exchanges.push(JSON.parse(init.body));
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
  }
  assert.equal(String(input), 'https://api.anthropic.com/api/oauth/profile');
  return Response.json({ account: { uuid: 'test-uuid', email: profileEmail } });
};
const server = createServer(async (req, res) => {
  if (!await handleAdminRequest(req, res, req.url, { adminTokenBuf: Buffer.from('admin'), onAccountsChanged: () => { reloads++; } })) res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const call = async (path, body, token = 'admin') => {
  const res = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const start = async () => {
  const result = await call('/admin/login/start', { alias: 'work' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert(!JSON.stringify(result.body).includes('codeVerifier'));
  return new URL(result.body.authorize_url);
};
try {
  await saveNetworkProfile({ version: 1, alias: 'work', enabled: true, proxyUrl: proxy, email: profileEmail });
  assert.equal((await call('/admin/login/start', { alias: 'work' }, 'wrong')).status, 401);
  assert.equal((await call('/admin/login/start', { alias: 'missing' })).status, 400);
  const url = await start();
  assert.equal(url.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');
  let list = await call('/admin/profiles');
  assert.equal(list.body.profiles[0].manualLoginPending, true);
  assert.equal((await call('/admin/profiles/work/update', { email: 'changed@example.com' })).status, 409);
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code#wrong' })).status, 400);
  assert.equal(exchanges.length, 0);
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: `code#${url.searchParams.get('state')}` })).status, 200);
  assert.equal(exchanges.length, 1);
  assert.equal(createHash('sha256').update(exchanges[0].code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal((await loadAccount('work')).networkProfile, 'work');
  assert.equal(reloads, 1);
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 410);
  await start();
  await call('/admin/profiles/work/cancel-login', {});
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 410);
  await start();
  await call('/admin/profiles/work/disable', {});
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 410);
  assert.equal((await call('/admin/login/start', { alias: 'work' })).status, 400);
  await call('/admin/profiles/work/enable', {});
  await start();
  await saveNetworkProfile({ ...loadNetworkProfile('work'), locale: 'en-US' });
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 409);
  await start(); profileEmail = 'other@example.com';
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 400);
  assert.equal((await loadAccount('work')).accessToken, 'test-access');
  await start();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 410);
  } finally { Date.now = realNow; }
  await start(); outage = true;
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 400);
  assert.equal((await call('/admin/login/complete', { alias: 'work', code: 'code' })).status, 410);
  assert.equal(reloads, 1);
  console.log('PASS: profile manual OAuth PKCE, proxy-bound exchange, hot reload, auth, state, single use, cancel, disabled/changed policy, email mismatch and proxy outage');
} finally { globalThis.fetch = nativeFetch; globalThis.Bun = originalBun; server.closeAllConnections(); server.close(); }
