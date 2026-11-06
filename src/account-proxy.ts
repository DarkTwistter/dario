import { curlProfileIp, diagnosticStart, diagnosticResponse, logProxyDiagnostic, redactDiagnostic, type ProxyDiagnostic } from './proxy-diagnostics.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir, readFile, open } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseOutboundProxy } from './outbound-proxy.js';

export type ProfileProvider = 'claude' | 'codex';
export interface AccountProxyProfile {
  provider: ProfileProvider;
  alias: string;
  proxyUrl: string;
  createdAt: string;
}
const home = join(homedir(), '.dario');
const directory = join(home, 'proxy-profiles');
const context = new AsyncLocalStorage<AccountProxyProfile>();
let installed = false;

export function accountProxyRequired(): boolean {
  return process.env.DARIO_REQUIRE_ACCOUNT_PROXY === '1';
}
function pathFor(provider: ProfileProvider, alias: string): string {
  if (!['claude', 'codex'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(alias)) {
    throw new Error('Invalid profile: provider must be claude or codex; alias must contain 1–64 letters, digits, _, - or .');
  }
  return join(directory, `${provider}.${alias}.json`);
}
function validProxy(raw: string): string {
  try {
    const parsed = parseOutboundProxy(raw);
    if (!parsed) throw new Error();
    const url = new URL(parsed.url);
    if (url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error();
    return parsed.url;
  } catch {
    throw new Error('Invalid proxy. Use http://user:password@host:port or https://user:password@host:port.');
  }
}
export function publicProxyProfile(profile: AccountProxyProfile) {
  const url = new URL(profile.proxyUrl);
  const authentication = Boolean(url.username || url.password);
  url.username = ''; url.password = '';
  return {provider:profile.provider, alias:profile.alias, proxy: url.origin, authentication, created_at:profile.createdAt};
}
export async function loadProxyProfile(provider: ProfileProvider, alias: string): Promise<AccountProxyProfile | null> {
  let raw: string;
  try { raw = await readFile(pathFor(provider, alias), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const profile = JSON.parse(raw) as AccountProxyProfile;
    if (profile.provider !== provider || profile.alias !== alias) throw new Error();
    validProxy(profile.proxyUrl);
    return profile;
  } catch { throw new Error(`Profile ${provider}/${alias} is unreadable; direct requests are disabled.`); }
}
export async function listProxyProfiles(): Promise<AccountProxyProfile[]> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const profiles: AccountProxyProfile[] = [];
  for (const file of files.filter(f => f.endsWith('.json')).sort()) {
    const match = /^(claude|codex)\.(.+)\.json$/.exec(file);
    if (!match) throw new Error('Invalid file in proxy-profiles; direct requests are disabled.');
    const profile = await loadProxyProfile(match[1] as ProfileProvider, match[2]);
    if (profile) profiles.push(profile);
  }
  return profiles;
}
export async function createProxyProfile(provider: ProfileProvider, alias: string, proxyUrl: string): Promise<AccountProxyProfile> {
  const path = pathFor(provider, alias);
  const profile: AccountProxyProfile = {provider, alias, proxyUrl:validProxy(proxyUrl), createdAt:new Date().toISOString()};
  // Validate the runtime before creating a profile that could appear configured but go direct.
  assertProxyRuntime();
  await mkdir(directory, {recursive:true, mode:0o700});
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Profile already exists. Its proxy binding is immutable.'); throw error; }
  try { await file.writeFile(JSON.stringify(profile, null, 2)); await file.sync(); }
  finally { await file.close(); }
  installAccountProxyRouting();
  return profile;
}
export async function requireProxyProfile(provider: ProfileProvider, alias: string): Promise<AccountProxyProfile | null> {
  const profile = await loadProxyProfile(provider, alias);
  if (!profile && accountProxyRequired()) throw new Error(`Create proxy profile ${provider}/${alias} before logging in. Direct requests are disabled.`);
  return profile;
}
function hasProxyProfiles(): boolean {
  try { return readdirSync(directory).some(file => file.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function withAccountProxy<T>(provider: ProfileProvider, alias: string, action: () => Promise<T>): Promise<T> {
  // Preserve existing single-flight timing when account profiles are not in use.
  if (!accountProxyRequired() && !hasProxyProfiles()) return action();
  return runWithAccountProxy(provider, alias, action);
}
async function runWithAccountProxy<T>(provider: ProfileProvider, alias: string, action: () => Promise<T>): Promise<T> {
  const profile = await requireProxyProfile(provider, alias);
  if (!profile) return action();
  installAccountProxyRouting();
  return context.run(profile, action);
}
function assertProxyRuntime(): void {
  const bun = (globalThis as {Bun?: {version?: string}}).Bun;
  if (!bun) {
    throw new Error('Account proxies require Bun. Refusing to send account requests with Node fetch, which ignores proxy settings.');
  }
  const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:$|[+-])/.exec(bun.version ?? '');
  if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 4)))) {
    throw new Error('Account proxies require Bun >= 1.4.4 to disable NO_PROXY bypass reliably. Direct requests are disabled.');
  }
}
function headersFor(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}
function refreshTokenFrom(body: BodyInit | null | undefined): string | undefined {
  if (body instanceof URLSearchParams) return body.get('refresh_token') ?? undefined;
  if (typeof body !== 'string') return undefined;
  try { return JSON.parse(body).refresh_token; } catch { return new URLSearchParams(body).get('refresh_token') ?? undefined; }
}
async function tokenOwners(token: string): Promise<Array<{provider: ProfileProvider; alias: string}>> {
  const owners: Array<{provider: ProfileProvider; alias: string}> = [];
  for (const [provider, folder] of [['claude','accounts'], ['codex','codex-accounts']] as const) {
    let files: string[];
    try { files = await readdir(join(home, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(f => f.endsWith('.json'))) {
      const record = JSON.parse(await readFile(join(home, folder, file), 'utf8'));
      if (record.accessToken === token || record.refreshToken === token) owners.push({provider, alias:record.alias});
    }
  }
  // The legacy single-account store shares the pool's reserved login profile.
  try {
    const record = JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8')).claudeAiOauth;
    if (record && (record.accessToken === token || record.refreshToken === token) && !owners.some(o => o.provider === 'claude')) owners.push({provider:'claude', alias:'login'});
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return owners;
}
function providerHost(input: RequestInfo | URL): boolean {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  return ['anthropic.com','claude.ai','claude.com','openai.com','chatgpt.com'].some(domain => host === domain || host.endsWith('.' + domain));
}
/** Global boundary: resolve credentials on every request, including retries, refresh and polling.
 * Profile context covers the code exchange before tokens exist on disk. No direct retry exists.
 */
export function createAccountProxyFetch(baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = headersFor(input, init).get('authorization');
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
    const token = bearer ?? refreshTokenFrom(init?.body);
    const owners = token ? await tokenOwners(token) : [];
    let profile = context.getStore();
    if (owners.length) {
      const profiles = await Promise.all(owners.map(owner => requireProxyProfile(owner.provider, owner.alias)));
      const bound = profiles.filter((p): p is AccountProxyProfile => p !== null);
      if (new Set(bound.map(p => p.proxyUrl)).size > 1) throw new Error('The same credentials belong to profiles with different proxies. Request blocked.');
      // The selected token is authoritative, even inside another account's async context.
      profile = bound[0];
      if (!profile && context.getStore()) throw new Error('Account token has no proxy profile. Request blocked.');
    }
    if (profile) {
      assertProxyRuntime();
      // Override caller-supplied proxy settings. Never allow a per-request direct escape.
      const options = {...init, proxy:{url:profile.proxyUrl, respectNoProxy:false}} as RequestInit;
      try { return await baseFetch(input, options); }
      catch { throw new Error(`Proxy request failed for ${profile.provider}/${profile.alias}. Direct connection is disabled.`); }
    }
    if (accountProxyRequired() && providerHost(input)) throw new Error('Provider request has no account proxy profile. Direct connection is disabled.');
    return baseFetch(input, init);
  }) as typeof fetch;
}
export function installAccountProxyRouting(): void {
  if (installed || (!accountProxyRequired() && !hasProxyProfiles())) return;
  assertProxyRuntime();
  globalThis.fetch = createAccountProxyFetch(globalThis.fetch);
  installed = true;
}
export async function testProxyProfile(provider: ProfileProvider, alias: string): Promise<{status: number; diagnostic: ProxyDiagnostic}> {
  const profile = await loadProxyProfile(provider, alias);
  if (!profile) throw new Error('Proxy profile does not exist.');
  const url = provider === 'claude' ? 'https://claude.ai/' : 'https://auth.openai.com/';
  const diagnostic = diagnosticStart(profile, url, 'profile-fetch');
  const started = Date.now();
  try {
    await withAccountProxy(provider, alias, async () => {
      const response = await fetch(url, {method:'GET', headers:diagnostic.request.headers, redirect:'manual', signal:AbortSignal.timeout(15000)});
      diagnostic.response = await diagnosticResponse(response, profile);
      diagnostic.proxy_reachable = response.status !== 407;
      diagnostic.provider_accessible = response.status >= 200 && response.status < 400;
      if (!diagnostic.provider_accessible) diagnostic.error = response.status === 407
        ? 'Proxy authentication failed. Check its username and password.'
        : `Provider returned HTTP ${response.status}. A proxy connection does not confirm provider access.`;
    });
  } catch (error) {
    diagnostic.error = redactDiagnostic(error instanceof Error ? error.message : 'Proxy test failed.', profile);
  }
  diagnostic.duration_ms = Date.now() - started;
  logProxyDiagnostic(diagnostic);
  return {status:diagnostic.response?.status ?? 0, diagnostic};
}
export async function testProxyProfileIp(provider: ProfileProvider, alias: string): Promise<ProxyDiagnostic> {
  const profile = await loadProxyProfile(provider, alias);
  if (!profile) throw new Error('Proxy profile does not exist.');
  return curlProfileIp(profile);
}
