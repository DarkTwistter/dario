import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = await mkdtemp(join(tmpdir(), 'dario-profiles-test-'));
process.env.USERPROFILE = process.env.HOME;
process.env.DARIO_PROFILE_ROOT = join(process.env.HOME, 'profiles');
delete process.env.DARIO_REQUIRE_ACCOUNT_PROXY;
const { accountFetch, saveNetworkProfile, loadNetworkProfile, publicNetworkProfile, profileDirectory, AccountProxyError } = await import('../dist/account-profiles.js');
const { saveAccount, loadAccount, backfillIdentity, refreshAccountToken, startAddAccount } = await import('../dist/accounts.js');
const { AccountPool, reconcilePoolAccounts } = await import('../dist/pool.js');
const { installOutboundProxyWrapper } = await import('../dist/outbound-proxy.js');
const originalBun = globalThis.Bun;
delete globalThis.Bun;
const a = { version: 1, alias: 'a', proxyUrl: 'http://user:secret@proxy-a.invalid:8080', enabled: true };
const b = { ...a, alias: 'b', proxyUrl: 'https://user:other@proxy-b.invalid:8443' };
await saveNetworkProfile(a); await saveNetworkProfile(b);
assert.equal((await stat(join(profileDirectory('a'), 'profile.json'))).mode & 0o777, 0o600);
assert.equal(JSON.stringify(publicNetworkProfile(a)).includes('secret'), false);
assert.equal(JSON.stringify(publicNetworkProfile(a)).includes('user:'), false);
for (const url of ['', 'socks5://localhost:1080', 'http://foo:bar@host:80/path', 'http://host/?password=secret']) {
  await assert.rejects(saveNetworkProfile({ ...a, proxyUrl: url }));
}
await assert.rejects(saveNetworkProfile({ ...a, alias: '../escape' }));
await assert.rejects(saveNetworkProfile({ ...a, timeZone: 'bad/timezone' }));
await assert.rejects(saveNetworkProfile({ ...a, locale: 'bad_locale' }));
let calls = [];
const transport = async (url, init) => {
  calls.push({ url, init });
  await new Promise(r => setTimeout(r, init.proxy?.includes('proxy-a') ? 10 : 1));
  return new Response(init.proxy ?? 'direct');
};
await assert.rejects(accountFetch({ alias: 'a', networkProfile: 'a' }, transport)('https://api.invalid/'), /require Bun/);
assert.equal(calls.length, 0, 'Node must fail before fetch, which ignores proxy');
globalThis.Bun = originalBun ?? {};
const seatA = { alias: 'a', networkProfile: 'a' }, seatB = { alias: 'b', networkProfile: 'b' };
const results = await Promise.all(Array.from({ length: 16 }, (_, n) => accountFetch(n % 2 ? seatA : seatB, transport)('https://api.invalid/').then(r => r.text())));
assert.equal(results.every((url, n) => url === (n % 2 ? a.proxyUrl : b.proxyUrl)), true, 'concurrent requests keep their own proxies');
assert.equal(calls.every(c => c.init.proxy), true);
const creds = { ...seatA, accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 1000, deviceId: 'd', accountUuid: 'u', scopes: [] };
await saveAccount(creds);
await saveAccount({ ...creds, networkProfile: undefined });
assert.equal((await loadAccount('a')).networkProfile, 'a', 'credential rewrites cannot silently erase network policy');
const pool = new AccountPool();
reconcilePoolAccounts(pool, [creds]);
assert.equal(pool.get('a').networkProfile, 'a');
pool.add('a', { ...creds, networkProfile: undefined });
assert.equal(pool.get('a').networkProfile, 'a', 'pool refresh preserves policy');
const savedFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(init.proxy, a.proxyUrl, 'refresh and identity requests use the account proxy');
    if (String(url).includes('/profile')) return Response.json({ account: { uuid: 'id-a' } });
    return Response.json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 });
  };
  const refreshed = await refreshAccountToken(creds);
  assert.equal(refreshed.networkProfile, 'a');
  const identified = await backfillIdentity(refreshed);
  assert.equal(identified.accountId, 'id-a');
  assert.equal(identified.networkProfile, 'a');
  await assert.rejects(startAddAccount('a'), /isolated browser/);
  // A process-wide proxy must never overwrite an explicit account proxy.
  let seen;
  globalThis.fetch = async (_url, init) => { seen = init.proxy; return new Response('ok'); };
  installOutboundProxyWrapper({ url: 'http://global.invalid:80', scheme: 'http', display: 'http://global.invalid/' });
  await (await accountFetch(seatA)('https://api.invalid/')).text();
  assert.equal(seen, a.proxyUrl);
} finally { globalThis.fetch = savedFetch; }
const before = calls.length;
await saveNetworkProfile({ ...a, enabled: false });
assert.equal(pool.select(), null, 'disabled profiles leave the routing pool');
await assert.rejects(accountFetch(seatA, transport)('https://api.invalid/'), AccountProxyError);
assert.equal(calls.length, before, 'disabled profiles never invoke transport');
await saveNetworkProfile(a);
await unlink(join(profileDirectory('a'), 'profile.json'));
await assert.rejects(accountFetch(seatA, transport)('https://api.invalid/'), /missing/);
await writeFile(join(profileDirectory('a'), 'profile.json'), '{broken');
await assert.rejects(accountFetch(seatA, transport)('https://api.invalid/'), /invalid/);
await saveNetworkProfile(a);
await assert.rejects(accountFetch(seatA, async () => { throw new Error(a.proxyUrl); })('https://api.invalid/'), error => !error.message.includes('secret') && error instanceof AccountProxyError);
// A live response must be aborted even after the response headers have arrived.
let aborted = false;
const streaming = accountFetch(seatA, async (_url, init) => new Response(new ReadableStream({
  start(controller) { init.signal.addEventListener('abort', () => { aborted = true; controller.error(init.signal.reason); }); },
})))('https://api.invalid/');
const response = await streaming;
const consume = response.text();
consume.catch(() => {});
await saveNetworkProfile({ ...a, enabled: false });
const deadline = setTimeout(() => {}, 2000);
try { await assert.rejects(consume, /interrupted/); } finally { clearTimeout(deadline); }
assert.equal(aborted, true);
process.env.DARIO_REQUIRE_ACCOUNT_PROXY = '1';
await assert.rejects(accountFetch({ alias: 'unknown' }, transport)('https://api.invalid/'), /missing/);
delete process.env.DARIO_REQUIRE_ACCOUNT_PROXY;
if (originalBun === undefined) delete globalThis.Bun; else globalThis.Bun = originalBun;
console.log('PASS: account policies, concurrency, refresh, identity, missing/disabled/corrupt profiles, stream revocation, no credential leaks');
