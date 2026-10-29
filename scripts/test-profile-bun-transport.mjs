// Real Bun HTTP and HTTPS CONNECT integration; no Anthropic calls or account secrets.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

if (!globalThis.Bun) throw new Error('Run this script with Bun');
const home = await mkdtemp(join(tmpdir(), 'dario-bun-transport-'));
process.env.HOME = home; process.env.USERPROFILE = home;
// Bun may cache os.homedir() before process.env.HOME changes. Never use a real profile root.
process.env.DARIO_PROFILE_ROOT = join(home, 'profiles');
const { accountFetch, saveNetworkProfile } = await import('../dist/account-profiles.js');
const key = join(home, 'key.pem'), cert = join(home, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=upstream.invalid', '-addext', 'subjectAltName=DNS:upstream.invalid'], { stdio: 'ignore' });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const tlsTarget = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => res.end('TLS through CONNECT'));
await listen(tlsTarget);
let directHits = 0;
const trap = httpServer((_req, res) => { directHits++; res.end('DIRECT LEAK'); });
await listen(trap);
const seen = [];
const sockets = new Set();
const makeProxy = async label => {
  const server = httpServer((req, res) => { seen.push({ label, method: req.method, auth: req.headers['proxy-authorization'] }); res.end(label); });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('connect', (req, client, head) => {
    seen.push({ label, method: 'CONNECT', target: req.url, auth: req.headers['proxy-authorization'] });
    const tunnel = connect(tlsTarget.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      client.pipe(tunnel); tunnel.pipe(client);
    });
    sockets.add(tunnel); tunnel.on('close', () => sockets.delete(tunnel));
    tunnel.on('error', () => client.destroy()); client.on('error', () => tunnel.destroy()); client.on('close', () => tunnel.destroy());
  });
  await listen(server);
  return server;
};
const pa = await makeProxy('a'), pb = await makeProxy('b');
const a = { alias: 'a', networkProfile: 'a' }, b = { alias: 'b', networkProfile: 'b' };
const profile = (alias, server) => ({ version: 1, alias, enabled: true, proxyUrl: `http://user:secret-${alias}@127.0.0.1:${server.address().port}` });
const configA = profile('a', pa), configB = profile('b', pb);
await saveNetworkProfile(configA); await saveNetworkProfile(configB);
try {
  const target = `http://127.0.0.1:${trap.address().port}/`;
  const outputs = await Promise.all(Array.from({ length: 16 }, (_, n) => accountFetch(n % 2 ? a : b)(target).then(r => r.text())));
  assert.equal(outputs.every((value, n) => value === (n % 2 ? 'a' : 'b')), true);
  // A private, throwaway CA is trusted for this call only, never disable TLS verification.
  const realTLS = (input, init) => fetch(input, { ...init, tls: { ca: readFileSync(cert) } });
  assert.equal(await (await accountFetch(a, realTLS)('https://upstream.invalid/')).text(), 'TLS through CONNECT');
  assert(seen.some(row => row.target === 'upstream.invalid:443'));
  assert(seen.every(row => row.auth === `Basic ${Buffer.from(`user:secret-${row.label}`).toString('base64')}`));
  assert.equal(directHits, 0);
  // Close only A's proxy: A must fail; B continues through B. Neither may reach the trap.
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => pa.close(resolve));
  await assert.rejects(accountFetch(a)(target), /proxy connection failed/);
  assert.equal(await (await accountFetch(b)(target)).text(), 'b');
  await saveNetworkProfile({ ...configB, enabled: false });
  await assert.rejects(accountFetch(b)(target), /disabled/);
  assert.equal(directHits, 0);
  console.log('PASS: real Bun concurrent proxies, Basic auth, TLS CONNECT, remote DNS, proxy outage, no direct fallback');
} finally {
  for (const socket of sockets) socket.destroy();
  pa.close(); pb.close(); tlsTarget.closeAllConnections(); tlsTarget.close(); trap.close();
}
