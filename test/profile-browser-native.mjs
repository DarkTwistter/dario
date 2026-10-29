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
let browser, secondBrowser;
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
  // Two ordinary windows must never join the same Chrome process/data directory or gateway.
  const secondRecord = join(home, 'second-launch.json');
  process.env.DARIO_NATIVE_BROWSER_RECORD = secondRecord;
  await saveNetworkProfile({ version: 1, alias: 'second', enabled: true, proxyUrl: 'http://second:other-secret@127.0.0.1:8', timeZone: 'America/New_York' });
  secondBrowser = await openProfileBrowser('second', 'https://claude.ai/oauth/authorize?state=second');
  const secondLaunch = JSON.parse(await readFile(secondRecord, 'utf8'));
  for (const prefix of ['--user-data-dir=', '--proxy-server=']) {
    assert.notEqual(launch.args.find(arg => arg.startsWith(prefix)), secondLaunch.args.find(arg => arg.startsWith(prefix)));
  }
  assert.equal(secondLaunch.timezone, 'America/New_York');
  assert.equal(secondLaunch.args.some(arg => arg.includes('other-secret')), false);
  await assert.rejects(openProfileBrowser('native', 'https://claude.ai/'), /already open/);
  const holder = JSON.parse(await readFile(join(process.env.DARIO_PROFILE_ROOT, 'native', 'browser.lock'), 'utf8'));
  const deadlineClose = setTimeout(() => { throw new Error('Browser stayed open after losing its lock'); }, 5000);
  try {
    process.kill(holder.holderPid, 'SIGKILL');
    await browser.closed;
  } finally { clearTimeout(deadlineClose); }
  await assert.rejects(openProfileBrowser('second', 'https://claude.ai/'), /already open/, 'closing one profile does not close the other');
  console.log('PASS: native OAuth launch without automation, concurrent isolated data directories/gateways/timezones, separate lifecycle and secret-free argv');
} finally {
  browser?.close(); secondBrowser?.close();
  if (browser) await browser.closed;
  if (secondBrowser) await secondBrowser.closed;
}
