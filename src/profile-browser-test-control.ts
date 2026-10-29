/** DevTools instrumentation exclusively for explicit headless test runs. Never used by login/check. */
import type { ChildProcess } from 'node:child_process';
import type { AccountNetworkProfile } from './account-profiles.js';
import type { ProfileBrowser } from './profile-browser.js';

export async function attachTestBrowserControl(
  child: ChildProcess,
  profile: AccountNetworkProfile,
  authorize: URL,
  gateway: { close(): void },
  closed: Promise<void>,
  options: { diagnostics?: (message: string) => void },
): Promise<ProfileBrowser> {
  // Only the opt-in headless test harness has a DevTools pipe.
  const input = child.stdio[3] as NodeJS.WritableStream;
  const output = child.stdio[4] as NodeJS.ReadableStream;
  let sequence = 0, buffered = '';
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Profile browser did not respond')); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  let sandboxDiagnostic = '';
  child.stderr?.on('data', chunk => {
    options.diagnostics?.(String(chunk));
    // Only sandbox launch errors are safe to include; browser output may contain OAuth URLs.
    const diagnostic = String(chunk).split('\n').find(line => line.startsWith('sandbox-exec:'));
    if (diagnostic) sandboxDiagnostic = diagnostic.slice(0, 250);
  });
  const rejectPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Profile browser closed (${child.exitCode ?? child.signalCode ?? 'unknown'})${sandboxDiagnostic ? `: ${sandboxDiagnostic}` : ''}`)); } pending.clear(); };
  let closing = false;
  let killTimer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closing) return;
    closing = true; gateway.close();
    // Let Chrome flush cookies to its profile before resorting to termination.
    void send('Browser.close').catch(() => {});
    killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500);
    killTimer.unref();
  };
  child.on('error', () => { rejectPending(); gateway.close(); });
  child.on('exit', () => { if (killTimer) clearTimeout(killTimer); rejectPending(); gateway.close(); });
  input.on('error', close);
  output.on('data', chunk => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf('\0')) !== -1) {
      const raw = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try {
        const message = JSON.parse(raw);
        const p = pending.get(message.id);
        if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error('Profile browser command failed')) : p.resolve(message.result); }
      } catch { /* ignore unrelated browser output */ }
    }
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    if (profile.timeZone) await send('Emulation.setTimezoneOverride', { timezoneId: profile.timeZone }, sessionId);
    if (profile.locale) await send('Emulation.setLocaleOverride', { locale: profile.locale.replace('-', '_') }, sessionId);
    await send('Page.navigate', { url: authorize.href }, sessionId);
    return { close, closed, evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error('Browser privacy check failed');
      return result.result?.value;
    } };
  } catch (err) { close(); throw err; }
}
