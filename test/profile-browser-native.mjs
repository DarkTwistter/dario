import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (process.platform === 'win32') { console.log('SKIP: executable fixture uses a Unix shebang'); process.exit(0); }
const home = await mkdtemp(join(tmpdir(), 'dario-native-browser-'));
process.env.DARIO_PROFILE_ROOT = join(home, 'profiles');
delete process.env.DARIO_BROWSER_LAUNCHER;
const record = join(home, 'launch.json');
const executable = join(home, 'browser.mjs');
await writeFile(executable, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.DARIO_NATIVE_BROWSER_RECORD, JSON.stringify({args:process.argv.slice(2),timezone:process.env.TZ,resolved:Intl.DateTimeFormat().resolvedOptions().timeZone}));
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);
`);
await chmod(executable, 0o700);
process.env.DARIO_BROWSER_EXECUTABLE = executable;
process.env.DARIO_NATIVE_BROWSER_RECORD = record;
const { saveNetworkProfile } = await import('../dist/account-profiles.js');
const { openProfileBrowser } = await import('../dist/profile-browser.js');
await saveNetworkProfile({ version: 1, alias: 'native', enabled: true, proxyUrl: 'http://user:secret@127.0.0.1:9', timeZone: 'Europe/Amsterdam', locale: 'en-US', email: 'test@example.com' });
const previousTZ = process.env.TZ;
let browser;
try {
  browser = await openProfileBrowser('native', 'https://claude.ai/oauth/authorize?state=fixture');
  let launch;
  const deadline = Date.now() + 5000;
  while (!launch) {
    try { launch = JSON.parse(await readFile(record, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.equal(launch.args.at(-1), 'https://claude.ai/oauth/authorize?state=fixture');
  assert(launch.args.some(arg => arg.startsWith('--proxy-server=http://127.0.0.1:')));
  assert(launch.args.some(arg => arg.startsWith('--user-data-dir=')));
  assert.equal(launch.args.some(arg => /remote-debugging|enable-automation|headless|AutomationControlled|no-sandbox/.test(arg)), false, 'ordinary profiles have no automation or automation-masking switches');
  assert.equal(launch.args.some(arg => arg.includes('secret')), false, 'upstream proxy password stays in the gateway');
  assert.equal(launch.timezone, 'Europe/Amsterdam');
  assert.equal(launch.resolved, 'Europe/Amsterdam');
  assert.equal(process.env.TZ, previousTZ, 'per-profile timezone never changes the Dario process');
  await assert.rejects(browser.evaluate('navigator.webdriver'), /automation is disabled/);
  console.log('PASS: native browser opens the OAuth URL directly, no automation/debugging/masking switches, native TZ, proxy credentials stay outside browser argv');
} finally { browser?.close(); if (browser) await browser.closed; }
