import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, unlink, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { acquireProfileBrowserLock } from '../dist/profile-browser-lock.js';
if (process.platform === 'win32') { console.log('SKIP: POSIX advisory locking'); process.exit(0); }
const directory = await mkdtemp(join(tmpdir(), 'dario-browser-lock-'));
const path = join(directory, 'browser.lock');
await writeFile(path, '', { mode: 0o600 }); // Legacy lock left by the old version.
let lock = await acquireProfileBrowserLock(directory);
const inode = (await stat(path)).ino;
await assert.rejects(acquireProfileBrowserLock(directory), /already open/);
await lock.release();
assert.equal((await stat(path)).ino, inode, 'released locks keep their inode stable');
lock = await acquireProfileBrowserLock(directory);
await lock.release();

// Recovery remains exclusive even when two callers race on an old file.
const racers = await Promise.allSettled([acquireProfileBrowserLock(directory), acquireProfileBrowserLock(directory)]);
assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1);
for (const result of racers) if (result.status === 'fulfilled') await result.value.release();

await mkdir(join(directory, 'browser'));
const singleton = join(directory, 'browser', 'SingletonLock');
await symlink(`${hostname()}-${process.pid}`, singleton);
await assert.rejects(acquireProfileBrowserLock(directory), /already open/, 'a live Chromium orphan cannot be bypassed');
await unlink(singleton);
const dead = spawn(process.execPath, ['-e', '']);
await once(dead, 'close');
await symlink(`${hostname()}-${dead.pid}`, singleton);
lock = await acquireProfileBrowserLock(directory);
await lock.release();
await unlink(singleton);

// Unexpected helper death is reported so the caller can close its browser.
lock = await acquireProfileBrowserLock(directory);
const holder = JSON.parse(await readFile(path, 'utf8'));
process.kill(holder.holderPid, 'SIGKILL');
let timer = setTimeout(() => { throw new Error('lost lock was not reported'); }, 5000);
await lock.lost;
clearTimeout(timer);
await lock.release();
lock = await acquireProfileBrowserLock(directory);
await lock.release();

// A killed Dario process drops the helper's stdin; the kernel releases the lock.
const fixture = join(directory, 'owner.mjs');
await writeFile(fixture, `import {acquireProfileBrowserLock} from ${JSON.stringify(new URL('../dist/profile-browser-lock.js', import.meta.url).href)};
await acquireProfileBrowserLock(process.argv[2]);console.log('READY');setInterval(()=>{},1000);`);
const owner = spawn(process.execPath, [fixture, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  await new Promise((resolve, reject) => {
    let output = '';
    timer = setTimeout(() => reject(new Error('owner startup timed out')), 5000);
    owner.on('error', reject);
    owner.stdout.on('data', data => { output += data; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
    owner.once('exit', code => { if (!output.includes('READY')) reject(new Error('owner failed: ' + code)); });
  });
  owner.kill('SIGKILL');
  await once(owner, 'close');
  const deadline = Date.now() + 5000;
  while (true) {
    try { lock = await acquireProfileBrowserLock(directory); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  await lock.release();
} finally { clearTimeout(timer); if (owner.exitCode === null && owner.signalCode === null) owner.kill(); }

// Do not truncate a credentials file if a lock path was accidentally symlinked to it.
const unsafe = await mkdtemp(join(tmpdir(), 'dario-lock-symlink-'));
const protectedFile = join(unsafe, 'credentials.json');
await writeFile(protectedFile, 'unchanged');
await symlink(protectedFile, join(unsafe, 'browser.lock'));
await assert.rejects(acquireProfileBrowserLock(unsafe), /Cannot acquire/);
assert.equal(await readFile(protectedFile, 'utf8'), 'unchanged');
console.log('PASS: legacy stale locks recover, active/concurrent owners stay exclusive, Chromium orphan protection, crash recovery and symlink safety');
