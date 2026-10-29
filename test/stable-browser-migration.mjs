import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProfileBrowserLock } from '../dist/profile-browser-lock.js';

if (process.platform === 'win32') { console.log('SKIP: Ubuntu migration requires POSIX'); process.exit(0); }
const helper = fileURLToPath(new URL('../deploy/ubuntu/prepare-stable-profiles.py', import.meta.url));
const installer = fileURLToPath(new URL('../deploy/ubuntu/install-stable-browser.sh', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'dario-stable-migration-'));
const root = join(temporary, 'profiles');
await mkdir(root);
const migrate = () => spawnSync('python3', [helper, root, '140.0.1.2'], { encoding: 'utf8', timeout: 5000 });
async function profile(alias, version) {
  const dir = join(root, alias);
  await mkdir(join(dir, 'browser'), { recursive: true });
  await writeFile(join(dir, 'profile.json'), JSON.stringify({ alias, proxyUrl: `http://${alias}.invalid:1234` }));
  await writeFile(join(dir, 'browser', 'cookies-fixture'), alias);
  if (version) await writeFile(join(dir, 'browser', 'Last Version'), version);
  return dir;
}
try {
  const compatible = await profile('compatible', '139.0.0.1');
  const newer = await profile('newer', '141.0.0.1');
  const unknown = await profile('unknown');
  const lock = await acquireProfileBrowserLock(newer);
  try {
    const result = migrate();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /active profile browser/);
    assert.deepEqual(await readdir(unknown), ['browser', 'profile.json'], 'failure must not partially archive other profiles');
  } finally { await lock.release(); }
  const singleton = join(newer, 'browser', 'SingletonLock');
  await symlink(`${hostname()}-${process.pid}`, singleton);
  assert.match(migrate().stderr, /Close the profile browser/);
  await rm(singleton);

  const result = migrate();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(compatible, 'browser', 'cookies-fixture'), 'utf8'), 'compatible');
  for (const [dir, alias] of [[newer, 'newer'], [unknown, 'unknown']]) {
    const entries = await readdir(dir);
    assert(!entries.includes('browser'));
    const archives = entries.filter(name => name.startsWith('browser-before-stable-'));
    assert.equal(archives.length, 1);
    assert.equal(await readFile(join(dir, archives[0], 'cookies-fixture'), 'utf8'), alias);
    assert.equal(JSON.parse(await readFile(join(dir, 'profile.json'), 'utf8')).proxyUrl, `http://${alias}.invalid:1234`);
    assert.equal((await stat(join(dir, 'browser.lock'))).mode & 0o777, 0o600);
  }
  assert.equal(migrate().status, 0, 'rerunning migration is safe');
  const unsafe = await profile('unsafe', '141.0.0.1');
  const secret = join(temporary, 'secret');
  await writeFile(secret, 'untouched');
  await symlink(secret, join(unsafe, 'browser.lock'));
  assert.notEqual(migrate().status, 0);
  assert.equal(await readFile(secret, 'utf8'), 'untouched');
  assert.equal(await readFile(join(unsafe, 'browser', 'cookies-fixture'), 'utf8'), 'unsafe');

  const shell = body => spawnSync('bash', ['-c', 'source "$1"; ' + body, 'test', installer], { encoding: 'utf8' });
  for (const [input, expected] of [['x86_64', 'amd64'], ['amd64', 'amd64'], ['aarch64', 'arm64'], ['arm64', 'arm64']]) {
    assert.equal(shell(`dario_chrome_arch ${input}`).stdout.trim(), expected);
  }
  assert.notEqual(shell('dario_chrome_arch i686').status, 0);
  assert.equal(shell('dario_chrome_version "Google Chrome 140.0.1.2"').stdout.trim(), '140.0.1.2');
  for (const name of ['Google Chrome for Testing 140.0.1.2', 'Chromium 140.0.1.2', 'Google Chrome 140.0']) {
    assert.notEqual(shell(`dario_chrome_version ${JSON.stringify(name)}`).status, 0);
  }
  console.log('PASS: Stable migration preserves isolated data/proxies, archives newer formats, refuses active/unsafe locks, supports both architectures and rejects testing builds');
} finally { await rm(temporary, { recursive: true, force: true }); }
