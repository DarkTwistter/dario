/** Per-account network policy. A bound account never falls back to direct egress. */
import { mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { durableWriteFile } from './durable-write.js';

export interface AccountNetworkProfile {
  version: 1;
  alias: string;
  proxyUrl: string;
  enabled: boolean;
  email?: string;
  timeZone?: string;
  locale?: string;
  /** Require a user-configured launcher that enforces an external network policy. */
  browserIsolation?: 'external';
}

export interface ProfileAccount { alias: string; networkProfile?: string }
const root = process.env.DARIO_PROFILE_ROOT ?? join(homedir(), '.dario', 'profiles');
export function profileDirectory(alias: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(alias)) throw new Error('Invalid profile alias');
  return join(root, alias);
}

export class AccountProxyError extends Error {
  readonly code = 'account_proxy_unavailable';
  constructor(readonly alias: string, reason: string) {
    super(`Account ${alias}: ${reason}`);
    this.name = 'AccountProxyError';
  }
}

export function validateProfile(value: unknown, alias: string): AccountNetworkProfile {
  profileDirectory(alias);
  if (!value || typeof value !== 'object') throw new AccountProxyError(alias, 'invalid network profile');
  const p = value as AccountNetworkProfile;
  if (p.version !== 1 || p.alias !== alias || typeof p.enabled !== 'boolean' || typeof p.proxyUrl !== 'string'
      || (p.email !== undefined && (typeof p.email !== 'string' || p.email.length > 320))) {
    throw new AccountProxyError(alias, 'invalid network profile');
  }
  try {
    const url = new URL(p.proxyUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || url.pathname !== '/') throw new Error();
    // Decode here too: malformed credentials must fail before any connection.
    decodeURIComponent(url.username); decodeURIComponent(url.password);
  } catch { throw new AccountProxyError(alias, 'expected an HTTP/HTTPS proxy URL'); }
  try {
    if (p.timeZone !== undefined && (typeof p.timeZone !== 'string' || !p.timeZone || !new Intl.DateTimeFormat('en', { timeZone: p.timeZone }))) throw new Error();
    if (p.locale !== undefined && (typeof p.locale !== 'string' || Intl.getCanonicalLocales(p.locale).length !== 1)) throw new Error();
    if (p.browserIsolation !== undefined && p.browserIsolation !== 'external') throw new Error();
  } catch { throw new AccountProxyError(alias, 'invalid browser locale, timezone or isolation setting'); }
  return { version: 1, alias, proxyUrl: p.proxyUrl, enabled: p.enabled, ...(p.email ? { email: p.email } : {}),
    ...(p.timeZone ? { timeZone: p.timeZone } : {}), ...(p.locale ? { locale: p.locale } : {}),
    ...(p.browserIsolation ? { browserIsolation: p.browserIsolation } : {}) };
}

export function loadNetworkProfile(alias: string): AccountNetworkProfile | null {
  const path = join(profileDirectory(alias), 'profile.json');
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AccountProxyError(alias, 'cannot read network profile');
  }
  try { return validateProfile(JSON.parse(raw), alias); }
  catch { throw new AccountProxyError(alias, 'invalid network profile'); }
}

export function requireNetworkProfile(alias: string): AccountNetworkProfile {
  const p = loadNetworkProfile(alias);
  if (!p) throw new AccountProxyError(alias, 'network profile is missing; direct access is forbidden');
  if (!p.enabled) throw new AccountProxyError(alias, 'proxy is disabled');
  return p;
}

export async function saveNetworkProfile(value: AccountNetworkProfile): Promise<void> {
  const p = validateProfile(value, value.alias);
  await mkdir(profileDirectory(p.alias), { recursive: true, mode: 0o700 });
  await durableWriteFile(join(profileDirectory(p.alias), 'profile.json'), JSON.stringify(p, null, 2), 0o600);
}

export async function listNetworkProfiles(): Promise<AccountNetworkProfile[]> {
  let names: string[];
  try { names = await readdir(root); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  return names.map(loadNetworkProfile).filter((p): p is AccountNetworkProfile => p !== null);
}

export function publicNetworkProfile(p: AccountNetworkProfile): object {
  const u = new URL(p.proxyUrl);
  return { alias: p.alias, enabled: p.enabled, email: p.email, timeZone: p.timeZone, locale: p.locale,
    proxy: `${u.protocol}//${u.host}`, authenticated: !!(u.username || u.password) };
}

/** Revoke active streams/tunnels when a profile changes, including edits by another process. */
export function watchNetworkPolicy(p: AccountNetworkProfile, revoke: () => void): () => void {
  const timer = setInterval(() => {
    try {
      const current = requireNetworkProfile(p.alias);
      if (current.proxyUrl === p.proxyUrl) return;
    } catch { /* deletion, corruption and disable all revoke the old connection */ }
    clearInterval(timer);
    revoke();
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}

/** No global proxy mutation: each concurrent request carries its own proxy. */
export function accountFetch(account: ProfileAccount, transport: typeof fetch = fetch): typeof fetch {
  return (async (input, init) => {
    const id = account.networkProfile ?? account.alias;
    const profile = loadNetworkProfile(id);
    if (!profile && !account.networkProfile && process.env.DARIO_REQUIRE_ACCOUNT_PROXY !== '1') return transport(input, init);
    const p = requireNetworkProfile(id);
    // Latch a discovered policy into the live seat as well as the persisted credential binding.
    account.networkProfile ??= id;
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
      throw new AccountProxyError(account.alias, 'account proxies require Bun; Node fetch would ignore the proxy');
    }
    const controller = new AbortController();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abort();
    else callerSignal?.addEventListener('abort', abort, { once: true });
    const stopWatching = watchNetworkPolicy(p, () => controller.abort(new AccountProxyError(account.alias, 'network policy changed')));
    const cleanup = () => { stopWatching(); callerSignal?.removeEventListener('abort', abort); };
    try {
      const response = await transport(input, { ...init, proxy: p.proxyUrl, signal: controller.signal } as RequestInit);
      if (!response.body) { cleanup(); return response; }
      // Keep the kill switch alive after headers arrive, until the response body finishes.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await reader.read();
            if (next.done) { cleanup(); stream.close(); }
            else stream.enqueue(next.value);
          } catch { cleanup(); stream.error(new AccountProxyError(account.alias, 'proxied response interrupted')); }
        },
        async cancel(reason) { cleanup(); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (err) {
      cleanup();
      if (callerSignal?.aborted) throw err;
      // Runtime errors can contain the full proxy URL, including its password.
      throw new AccountProxyError(account.alias, 'proxy connection failed; direct access is forbidden');
    }
  }) as typeof fetch;
}
