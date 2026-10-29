/** Dedicated Chromium process + authenticated upstream proxy. No third-party runtime dependencies. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, mkdtemp, chmod, rmdir } from 'node:fs/promises';
import { createServer, request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { userInfo, tmpdir } from 'node:os';
import { AccountProxyError, profileDirectory, requireNetworkProfile, watchNetworkPolicy } from './account-profiles.js';
import { durableWriteFile } from './durable-write.js';
import { acquireProfileBrowserLock } from './profile-browser-lock.js';

export interface ProfileBrowser {
  close(): void;
  closed: Promise<void>;
  /** Used by the local privacy self-test, never exposed over an unauthenticated endpoint. */
  evaluate(expression: string): Promise<unknown>;
}

/** Duration of a manually opened IP-check window. Zero disables automatic closure. */
export function browserCheckTimeoutMs(raw = process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES): number {
  if (raw === undefined || raw.trim() === '') return 30 * 60_000;
  if (!/^\d+$/.test(raw.trim())) throw new Error('DARIO_BROWSER_CHECK_TIMEOUT_MINUTES must be an integer from 0 to 1440 (0 = no automatic closure)');
  const minutes = Number(raw.trim());
  if (minutes > 1440) throw new Error('DARIO_BROWSER_CHECK_TIMEOUT_MINUTES must be between 0 and 1440');
  return minutes * 60_000;
}

/** The only direct browser request permitted is the exact OAuth callback on loopback. */
export async function startProfileGateway(alias: string, callbackUrl?: string, options: { unixSocket?: boolean } = {}): Promise<{ url: string; socketPath?: string; close(): void }> {
  const profile = requireNetworkProfile(alias);
  const proxy = new URL(profile.proxyUrl);
  const callback = callbackUrl ? new URL(callbackUrl) : undefined;
  if (callback && (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) || callback.pathname !== '/callback')) {
    throw new Error('Invalid local OAuth callback');
  }
  const sockets = new Set<Socket>();
  const track = (socket: Socket): Socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const credentials = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
  const upstreamOptions = (): RequestOptions => ({
    hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
    agent: false, timeout: 15_000,
  });
  const viaProxy = proxy.protocol === 'https:' ? httpsRequest : httpRequest;
  const check = () => {
    if (requireNetworkProfile(alias).proxyUrl !== profile.proxyUrl) throw new AccountProxyError(alias, 'proxy changed; restart login');
  };
  const server = createServer((req, res) => {
    try {
      check();
      const target = new URL(req.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error('Unsupported browser request');
      const isCallback = callback && target.origin === callback.origin && target.pathname === callback.pathname && req.method === 'GET';
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection']; delete headers.connection;
      if (!isCallback && credentials) headers['proxy-authorization'] = credentials;
      const outgoing = isCallback
        ? httpRequest(target, { method: 'GET', headers, agent: false, timeout: 15_000 })
        : viaProxy({ ...upstreamOptions(), method: req.method, path: target.href, headers });
      outgoing.on('socket', track);
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Profile proxy unavailable'); });
      outgoing.on('response', response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
      res.on('close', () => outgoing.destroy());
      req.pipe(outgoing);
    } catch { res.writeHead(503); res.end('Profile proxy unavailable'); }
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    try {
      check();
      const authority = req.url ?? '';
      const destination = new URL(`https://${authority}`);
      if (!authority || destination.username || destination.password || destination.pathname !== '/' || destination.search || destination.hash
          || !/^(\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]+$/i.test(authority)) throw new Error('Invalid CONNECT target');
      const headers: Record<string, string> = { host: authority };
      if (credentials) headers['proxy-authorization'] = credentials;
      const outgoing = viaProxy({ ...upstreamOptions(), method: 'CONNECT', path: authority, headers });
      outgoing.on('socket', track);
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => client.destroy());
      client.on('error', () => outgoing.destroy());
      outgoing.on('connect', (response, tunnel, upstreamHead) => {
        track(tunnel);
        tunnel.setTimeout(0);
        if (response.statusCode !== 200) { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); tunnel.destroy(); return; }
        try { check(); } catch { tunnel.destroy(); client.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (upstreamHead.length) client.write(upstreamHead);
        if (head.length) tunnel.write(head);
        tunnel.on('error', () => client.destroy());
        client.on('close', () => tunnel.destroy());
        tunnel.on('close', () => client.destroy());
        client.pipe(tunnel); tunnel.pipe(client);
      });
      client.once('close', () => outgoing.destroy());
      outgoing.end();
    } catch { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  let stopWatching = () => {};
  let unixServer: ReturnType<typeof createServer> | undefined;
  let socketPath: string | undefined;
  let socketDirectory: string | undefined;
  const close = () => {
    stopWatching(); server.close();
    unixServer?.close(() => { if (socketDirectory) void rmdir(socketDirectory).catch(() => {}); });
    for (const socket of sockets) socket.destroy();
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  if (options.unixSocket) {
    try {
      socketDirectory = await mkdtemp(join(tmpdir(), 'dario-egress-'));
      socketPath = join(socketDirectory, 'proxy.sock');
      unixServer = createServer();
      for (const event of ['request', 'connect']) {
        for (const listener of server.listeners(event)) unixServer.on(event, listener as (...args: any[]) => void);
      }
      unixServer.on('connection', track);
      await new Promise<void>((resolve, reject) => { unixServer!.once('error', reject); unixServer!.listen(socketPath!, resolve); });
      await chmod(socketPath, 0o600);
    } catch (err) { close(); throw err; }
  }
  stopWatching = watchNetworkPolicy(profile, close);
  const address = server.address();
  if (!address || typeof address === 'string') { close(); throw new Error('Browser gateway failed to bind'); }
  return { url: `http://127.0.0.1:${address.port}`, socketPath, close };
}

export function findProfileBrowser(): string {
  const candidates = [process.env.DARIO_BROWSER_EXECUTABLE, ...(process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])];
  const executable = candidates.find((path): path is string => !!path && existsSync(path));
  if (!executable) throw new Error('Chromium/Chrome not found. Set DARIO_BROWSER_EXECUTABLE to its executable path.');
  return executable;
}

export async function openProfileBrowser(alias: string, authorizeUrl: string, callbackUrl?: string, options: { headless?: boolean; diagnostics?: (message: string) => void; networkLog?: string } = {}): Promise<ProfileBrowser> {
  const lock = await acquireProfileBrowserLock(profileDirectory(alias));
  try {
    const browser = await launchProfileBrowser(alias, authorizeUrl, callbackUrl, options, lock.release);
    void lock.lost.then(() => browser.close());
    return browser;
  } catch (err) { await lock.release(); throw err; }
}

async function launchProfileBrowser(alias: string, authorizeUrl: string, callbackUrl: string | undefined, options: { headless?: boolean; diagnostics?: (message: string) => void; networkLog?: string }, release: () => Promise<void>): Promise<ProfileBrowser> {
  const profile = requireNetworkProfile(alias);
  const authorize = new URL(authorizeUrl);
  if (authorize.protocol !== 'https:') throw new Error('Profile authorization requires HTTPS');
  const executable = findProfileBrowser();
  const launcher = process.env.DARIO_BROWSER_LAUNCHER;
  if (profile.browserIsolation === 'external' && !launcher) throw new Error('External browser isolation requires DARIO_BROWSER_LAUNCHER');
  const userData = join(profileDirectory(alias), 'browser');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const defaults = join(userData, 'Default');
  await mkdir(defaults, { recursive: true, mode: 0o700 });
  const preferencesPath = join(defaults, 'Preferences');
  let preferences: Record<string, any> = {};
  try { preferences = JSON.parse(await readFile(preferencesPath, 'utf8')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read browser preferences'); }
  preferences.webrtc = { ...preferences.webrtc, ip_handling_policy: 'disable_non_proxied_udp' };
  preferences.net = { ...preferences.net, network_prediction_options: 2 };
  preferences.dns_over_https = { mode: 'off' };
  if (profile.locale) preferences.intl = { ...preferences.intl, accept_languages: profile.locale };
  else if (preferences.intl) delete preferences.intl.accept_languages;
  await durableWriteFile(preferencesPath, JSON.stringify(preferences));
  const gateway = await startProfileGateway(alias, callbackUrl, { unixSocket: !!launcher });
  const browserArgs = [
    `--user-data-dir=${userData}`, `--proxy-server=${gateway.url}`, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--dns-prefetch-disable',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-background-mode',
    '--disable-features=MediaRouter,DnsOverHttps,UseDnsHttpsSvcbAlpn',
    ...(profile.locale ? [`--lang=${profile.locale}`] : []),
    ...(options.headless ? ['--headless=new', '--use-mock-keychain', '--remote-debugging-pipe'] : []),
    ...(options.networkLog ? [`--log-net-log=${options.networkLog}`] : []),
    '--no-first-run', '--no-default-browser-check', options.headless ? 'about:blank' : authorize.href,
  ];
  // A profile is isolated with user-data-dir, never by replacing macOS HOME (which breaks Keychain).
  const browserEnv = { ...process.env, ...(process.platform === 'darwin' ? { HOME: userInfo().homedir } : {}), ...(profile.timeZone ? { TZ: profile.timeZone } : {}) };
  // Do not nest sandbox-exec around Chrome: macOS rejects Chrome's own seatbelt sandbox.
  // A launcher can enforce a dedicated firewall/namespace while preserving Chrome's sandbox.
  const stdio: ('ignore' | 'pipe')[] = options.headless ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'];
  const child = launcher
    ? spawn(launcher, [executable, ...browserArgs], { stdio, env: { ...browserEnv, DARIO_BROWSER_GATEWAY: gateway.url, DARIO_BROWSER_GATEWAY_SOCKET: gateway.socketPath } })
    : spawn(executable, browserArgs, { stdio, env: browserEnv });
  const closed = new Promise<void>(resolve => child.once('close', () => {
    gateway.close();
    void release().then(resolve);
  }));
  child.on('error', () => gateway.close());
  if (options.headless) {
    const { attachTestBrowserControl } = await import('./profile-browser-test-control.js');
    return attachTestBrowserControl(child, profile, authorize, gateway, closed, options);
  }
  // A user's browser is a regular process: no CDP, injected scripts or WebDriver.
  child.stderr?.on('data', chunk => options.diagnostics?.(String(chunk)));
  let closing = false;
  let killTimer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closing) return;
    closing = true;
    gateway.close();
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    killTimer.unref();
  };
  child.once('close', () => { if (killTimer) clearTimeout(killTimer); });
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const clear = () => { if (timer) clearTimeout(timer); child.off('error', fail); child.off('exit', exited); };
      const fail = () => { clear(); reject(new Error('Profile browser could not start')); };
      const exited = () => { clear(); reject(new Error(`Profile browser exited during startup (${child.exitCode ?? child.signalCode ?? 'unknown'})`)); };
      child.once('error', fail); child.once('exit', exited);
      child.once('spawn', () => { timer = setTimeout(() => { clear(); resolve(); }, 300); });
    });
    return { close, closed, evaluate: async () => { throw new Error('Page automation is disabled for normal profile browsers'); } };
  } catch (err) { close(); throw err; }
}
