// Offline integration test. Launches the installed Chrome in a temporary profile.
// Requires permission to launch Chrome. Never accesses the real account profile or Keychain.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dario-privacy-smoke-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.DARIO_PROFILE_ROOT = join(home, 'profiles');
const { saveNetworkProfile } = await import('../dist/account-profiles.js');
const { openProfileBrowser } = await import('../dist/profile-browser.js');
const listen = server => new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
const requests = [];
const proxy = createServer((req, res) => { requests.push(req.url); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('proxied'); });
proxy.on('connect', (req, socket) => { requests.push(req.url); socket.end('HTTP/1.1 502 Test Proxy\r\nConnection: close\r\n\r\n'); });
await listen(proxy);
let directHits = 0, udpHits = 0;
const direct = createServer((_req, res) => { directHits++; res.end('direct'); });
await listen(direct);
const udp = createSocket('udp4');
udp.on('message', () => udpHits++);
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
let browser;
const networkLog = join(home, 'netlog.json');
try {
  const alias = 'privacy-smoke';
  await saveNetworkProfile({ version: 1, alias, proxyUrl: `http://127.0.0.1:${proxy.address().port}`, enabled: true, locale: 'en-US', timeZone: 'America/New_York' });
  browser = await openProfileBrowser(alias, 'https://privacy-probe.invalid/', undefined, { headless: true, networkLog });
  await assert.rejects(openProfileBrowser(alias, 'https://privacy-probe.invalid/', undefined, { headless: true }), /already open/);
  const info = await browser.evaluate('({ timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, language:navigator.language, userAgent:navigator.userAgent })');
  assert.equal(info.timezone, 'America/New_York');
  assert.equal(info.language, 'en-US');
  // Even explicit loopback and numeric-IP requests must use the browser gateway.
  await browser.evaluate(`fetch('http://127.0.0.1:${direct.address().port}/browser-probe').catch(()=>null).then(()=>true)`);
  const candidates = await browser.evaluate(`new Promise(async resolve => {
    const pc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});
    const candidates=[]; pc.onicecandidate=e=>{if(e.candidate)candidates.push(e.candidate.candidate)};
    pc.createDataChannel('privacy'); await pc.setLocalDescription(await pc.createOffer());
    setTimeout(()=>{pc.close();resolve(candidates)}, 1500);
  })`);
  assert.deepEqual(candidates, [], 'WebRTC must expose neither private nor public host candidates');
  assert.equal(udpHits, 0, 'WebRTC must not send STUN packets directly');
  assert.equal(directHits, 0);
  assert(requests.some(url => url === 'privacy-probe.invalid:443'), 'CONNECT forwards a hostname without local DNS resolution');
  assert(requests.some(url => url.includes('/browser-probe')), 'browser fetch used the proxy');

  browser.close(); await browser.closed;
  const netlog = JSON.parse(await readFile(networkLog, 'utf8'));
  const names = Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([name, id]) => [id, name]));
  const dnsQueries = netlog.events.filter(event => /DNS_TRANSACTION/.test(names[event.type] ?? '') && JSON.stringify(event.params).includes('privacy-probe.invalid'));
  assert.equal(dnsQueries.length, 0, 'test hostname must not generate local DNS transactions');
  console.log(JSON.stringify({ result: 'PASS', browser: info, candidates, localDnsQueries: dnsQueries.length, directHits, udpHits, proxyRequests: requests.length }, null, 2));
} finally {
  browser?.close(); proxy.closeAllConnections(); proxy.close(); direct.close(); udp.close();
}
