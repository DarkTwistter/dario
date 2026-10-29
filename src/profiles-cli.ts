import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { addAccountViaOAuth, loadAccount, saveAccount } from './accounts.js';
import { loadNetworkProfile, saveNetworkProfile, listNetworkProfiles, publicNetworkProfile, requireNetworkProfile, type AccountNetworkProfile } from './account-profiles.js';
import { openProfileBrowser } from './profile-browser.js';

async function liveAdmin(path: string, body: object): Promise<boolean> {
  if (process.env.DARIO_ADMIN !== '1' || !process.env.DARIO_ADMIN_TOKEN) return false;
  const port = Number(process.env.DARIO_PORT ?? 3456);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DARIO_PORT');
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.DARIO_ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(330_000),
  });
  if (!response.ok) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error ?? 'Profile admin operation failed');
  }
  await response.body?.cancel();
  return true;
}

export async function readProfileSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Use --file=PATH to supply a profile without an interactive terminal');
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stdout.write(prompt);
  try { return await rl.question(''); }
  finally { rl.close(); process.stdout.write('\n'); }
}

export async function runProfiles(args: string[]): Promise<void> {
  const action = args[1] ?? 'list';
  if (action === 'list') {
    console.log(JSON.stringify((await listNetworkProfiles()).map(publicNetworkProfile), null, 2));
    return;
  }
  const alias = args[2];
  if (!alias) throw new Error('Usage: dario profiles <create|login|check|enable|disable> <alias>');
  if (action === 'create') {
    if (loadNetworkProfile(alias)) throw new Error('Profile already exists; edit its protected profile.json to change the proxy');
    const file = args.find(a => a.startsWith('--file='))?.slice(7);
    let profile: AccountNetworkProfile;
    if (file) {
      const data = JSON.parse(await readFile(file, 'utf8'));
      profile = { ...data, version: 1, alias, enabled: true };
    } else {
      const proxyUrl = await readProfileSecret('Proxy URL (http://user:password@host:port; hidden): ');
      const email = await readProfileSecret('Claude email (optional): ');
      const timeZone = await readProfileSecret('Exit timezone, e.g. Europe/Berlin (optional): ');
      const locale = await readProfileSecret('Browser locale, e.g. en-US (optional): ');
      profile = { version: 1, alias, proxyUrl, enabled: true, ...(email ? { email } : {}), ...(timeZone ? { timeZone } : {}), ...(locale ? { locale } : {}) };
    }
    if (process.env.DARIO_BROWSER_LAUNCHER) profile.browserIsolation = 'external';
    if (!await liveAdmin('/admin/profiles', profile)) {
      await saveNetworkProfile(profile);
      const account = await loadAccount(alias);
      if (account) await saveAccount({ ...account, networkProfile: alias });
    }
    console.log(`Profile ${alias} created. Run: dario profiles login ${alias}`);
    return;
  }
  const profile = loadNetworkProfile(alias);
  if (!profile) throw new Error('Unknown profile');
  if (action === 'enable' || action === 'disable') {
    await saveNetworkProfile({ ...profile, enabled: action === 'enable' });
    console.log(`Profile ${alias}: ${action === 'enable' ? 'enabled' : 'disabled'}`);
    return;
  }
  if (action === 'login') {
    requireNetworkProfile(alias);
    if (await liveAdmin(`/admin/profiles/${alias}/login`, {})) {
      console.log(`Profile ${alias} authenticated and active in the running Dario.`);
      return;
    }
    await addAccountViaOAuth(alias);
    console.log(`Profile ${alias} authenticated. Restart the proxy to reload CLI account changes, or use the admin profile login endpoint.`);
    return;
  }
  if (action === 'check') {
    const browser = await openProfileBrowser(alias, 'https://cleanip.io/claude');
    console.log('CleanIP opened through the profile proxy. Complete the checks in that window; press Enter to close.');
    try { await readProfileSecret(''); } finally { browser.close(); }
    return;
  }
  throw new Error('Usage: dario profiles <create|list|login|check|enable|disable> [alias] [--file=PATH]');
}
