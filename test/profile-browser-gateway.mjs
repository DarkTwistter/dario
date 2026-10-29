import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HOME = await mkdtemp(join(tmpdir(), 'dario-browser-gateway-'));
process.env.USERPROFILE = process.env.HOME;
process.env.DARIO_PROFILE_ROOT = join(process.env.HOME, 'profiles');
const { saveNetworkProfile } = await import('../dist/account-profiles.js');
const { startProfileGateway } = await import('../dist/profile-browser.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sockets = new Set();
const seen = [];
const proxy = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers['proxy-authorization'] }); res.end('upstream-proxy'); });
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('connect', (req, socket) => {
  seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  socket.on('data', data => socket.write(data));
});
await listen(proxy);
const profile = { version: 1, alias: 'browser', proxyUrl: `http://name:p%40ss@127.0.0.1:${proxy.address().port}`, enabled: true };
await saveNetworkProfile(profile);
let callbacks = 0, directRequests = 0;
const callback = createServer((_req, res) => { callbacks++; res.end('callback'); });
const trap = createServer((_req, res) => { directRequests++; res.end('DIRECT LEAK'); });
await listen(callback); await listen(trap);
const callbackUrl = `http://127.0.0.1:${callback.address().port}/callback`;
const gateway = await startProfileGateway('browser', callbackUrl, { unixSocket: true });
const get = target => new Promise((resolve, reject) => {
  const req = request(gateway.url, { path: target, timeout: 1500 }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
});
try {
  assert.equal((await stat(gateway.socketPath)).mode & 0o777, 0o600);
  const throughUnix = await new Promise((resolve, reject) => {
    const req = request({ socketPath: gateway.socketPath, path: 'http://unix-test.invalid/path' }, res => {
      let body = ''; res.on('data', data => body += data); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(throughUnix, 'upstream-proxy', 'namespace relay can use the protected Unix gateway');
  assert.equal((await get('http://does-not-resolve.invalid/page')).body, 'upstream-proxy');
  assert.equal((await get(`http://127.0.0.1:${trap.address().port}/`)).body, 'upstream-proxy');
  assert.equal(directRequests, 0, 'even loopback URLs have no implicit bypass');
  assert.equal((await get(`${callbackUrl}?code=test&state=test`)).body, 'callback');
  assert.equal(callbacks, 1);
  assert.equal((await get(callbackUrl.replace('/callback', '/other'))).body, 'upstream-proxy');
  assert.equal(callbacks, 1, 'only the exact callback path bypasses upstream');
  const client = connect(Number(new URL(gateway.url).port), '127.0.0.1');
  let raw = '';
  const echoed = new Promise((resolve, reject) => {
    client.setTimeout(2000, () => reject(new Error('CONNECT timeout')));
    client.on('error', reject);
    client.on('data', data => { raw += data; if (raw.includes('tunnel-marker')) resolve(); });
  });
  client.write('CONNECT remote-does-not-resolve.invalid:443 HTTP/1.1\r\nHost: remote-does-not-resolve.invalid:443\r\n\r\ntunnel-marker');
  await echoed;
  assert.equal(seen.at(-1).url, 'remote-does-not-resolve.invalid:443', 'remote hostname stays unresolved until upstream');
  assert.equal(seen.every(row => row.auth === `Basic ${Buffer.from('name:p@ss').toString('base64')}`), true);
  const closed = new Promise(resolve => client.once('close', resolve));
  await saveNetworkProfile({ ...profile, enabled: false });
  await closed;
  await assert.rejects(get('http://another.invalid/'));
  assert.equal(directRequests, 0);
  console.log('PASS: proxy authentication, remote hostname forwarding, exact callback, CONNECT, browser tunnel kill switch');
} finally {
  gateway.close(); for (const socket of sockets) socket.destroy();
  proxy.close(); callback.close(); trap.close();
}
