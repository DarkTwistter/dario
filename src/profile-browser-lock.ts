/** Kernel advisory locks on POSIX: an old lock file alone never blocks a profile. */
import { spawn } from 'node:child_process';
import { mkdir, open, unlink, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface ProfileBrowserLock {
  release(): Promise<void>;
  /** Unexpected loss of the holder must close the browser rather than leave it unprotected. */
  lost: Promise<void>;
}

const busy = () => new Error('This profile browser is already open. Close its window in VNC before opening it again.');

// Ubuntu setup already installs Python 3. The helper holds flock until its stdin closes.
// Keep the inode on disk: unlinking a held advisory lock would allow a second owner.
const LOCK_HELPER = `import os, sys, fcntl, stat, json
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    sys.exit(74)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
os.ftruncate(fd, 0)
os.write(fd, json.dumps({'version': 1, 'ownerPid': int(sys.argv[2]), 'holderPid': os.getpid()}).encode())
sys.stdout.write('LOCKED\\n')
sys.stdout.flush()
sys.stdin.buffer.read()
os.close(fd)
`;

/** Also protect a Chrome orphan left running outside the original Dario process. */
async function assertChromeNotRunning(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let target: string;
  try { target = await readlink(join(directory, 'browser', 'SingletonLock')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot verify the Chromium profile lock. Close the profile browser and check its permissions.');
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname()) throw new Error('Chromium profile belongs to another or unknown host; refusing concurrent access.');
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw busy();
  try { process.kill(pid, 0); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw busy(); // EPERM and unknown errors do not prove that the owner is gone.
  }
  throw busy();
}

export async function acquireProfileBrowserLock(directory: string): Promise<ProfileBrowserLock> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'browser.lock');
  if (process.platform === 'win32') {
    // Preserve the previous exclusive-file behaviour on Windows (no fcntl).
    const file = await open(path, 'wx', 0o600).catch(() => { throw busy(); });
    await file.close();
    let released = false;
    return { lost: new Promise(() => {}), release: async () => {
      if (!released) { released = true; await unlink(path).catch(() => {}); }
    } };
  }
  const holder = spawn(process.env.DARIO_PYTHON_EXECUTABLE ?? 'python3', ['-c', LOCK_HELPER, path, String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false, releasing = false;
  let resolveLost!: () => void;
  const lost = new Promise<void>(resolve => { resolveLost = resolve; });
  const closed = new Promise<void>(resolve => holder.once('close', () => resolve()));
  const release = (): Promise<void> => { if (!releasing) { releasing = true; holder.stdin.end(); } return closed; };
  holder.stdin.on('error', () => { /* a dead holder is handled by close */ });
  holder.stderr.resume(); // Never put helper output or profile paths in API errors.
  holder.on('close', () => { if (ready && !releasing) resolveLost(); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { holder.kill(); reject(new Error('Timed out acquiring the profile browser lock')); }, 5000);
      holder.once('error', () => { clearTimeout(timer); reject(new Error('python3 is required for profile browser locks. Install python3 and restart Dario.')); });
      holder.once('close', code => { clearTimeout(timer); if (!ready) reject(code === 73 ? busy() : new Error('Cannot acquire the profile browser lock; check permissions and python3.')); });
      holder.stdout.on('data', chunk => {
        output += String(chunk);
        if (!ready && output.includes('LOCKED\n')) { ready = true; clearTimeout(timer); resolve(); }
      });
    });
    await assertChromeNotRunning(directory);
    return { release, lost };
  } catch (err) { await release(); throw err; }
}
