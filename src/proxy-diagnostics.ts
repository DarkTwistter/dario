import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import type { AccountProxyProfile } from './account-proxy.js';

const BODY_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
export type ProxyDiagnostic = {
  trace_id: string;
  checked_at: string;
  provider: string;
  alias: string;
  proxy: string;
  request: { method: string; url: string; headers: Record<string, string>; redirect: string; timeout_ms: number; transport: string };
  response: { status: number; headers: Record<string, string>; body: string; body_truncated: boolean; connected_ip?: string; connect_status?: number } | null;
  duration_ms: number;
  proxy_reachable: boolean;
  provider_accessible: boolean;
  observed_ip?: string | null;
  curl_exit_code?: number | null;
  error?: string;
};
export function redactDiagnostic(text: string, profile: AccountProxyProfile): string {
  const url = new URL(profile.proxyUrl);
  const secrets = [profile.proxyUrl, url.username, url.password, process.env.DARIO_API_KEY, process.env.DARIO_ADMIN_TOKEN];
  for (const value of [url.username, url.password]) {
    try { secrets.push(decodeURIComponent(value)); } catch { /* Invalid URL escapes are never decoded. */ }
  }
  let safe = text;
  for (const value of secrets.filter((s): s is string => Boolean(s)).sort((a, b) => b.length - a.length)) safe = safe.split(value).join('[redacted]');
  return safe.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [redacted]')
    .replace(/(["']?(?:access_token|refresh_token|api_key|password|client_secret)["']?\s*[:=]\s*["']?)[^\s"'<>,;&]+/gi, '$1[redacted]');
}
export function diagnosticStart(profile: AccountProxyProfile, url: string, transport: string): ProxyDiagnostic {
  return {
    trace_id: randomUUID(), checked_at: new Date().toISOString(), provider: profile.provider, alias: profile.alias,
    proxy: new URL(profile.proxyUrl).origin,
    request: { method: 'GET', url, headers: { accept: 'text/plain, text/html;q=0.9', 'accept-encoding': 'identity' }, redirect: 'manual', timeout_ms: 15000, transport },
    response: null, duration_ms: 0, proxy_reachable: false, provider_accessible: false,
  };
}
export function logProxyDiagnostic(diagnostic: ProxyDiagnostic) {
  console.info('[dario] proxy-check ' + JSON.stringify(diagnostic));
}
export async function diagnosticResponse(response: Response, profile: AccountProxyProfile) {
  const allowed = ['content-type', 'content-length', 'date', 'server', 'via', 'cf-ray', 'cf-cache-status', 'request-id', 'x-request-id', 'retry-after'];
  const headers: Record<string, string> = {};
  for (const name of allowed) {
    const value = response.headers.get(name);
    if (value) headers[name] = redactDiagnostic(value.slice(0, 1024), profile);
  }
  const reader = response.body?.getReader();
  let bytes = new Uint8Array();
  let truncated = false;
  try {
    if (reader) while (bytes.byteLength < BODY_LIMIT) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = BODY_LIMIT - bytes.byteLength;
      const next = new Uint8Array(bytes.byteLength + Math.min(value.byteLength, remaining));
      next.set(bytes); next.set(value.subarray(0, remaining), bytes.byteLength); bytes = next;
      if (value.byteLength >= remaining) { truncated = true; break; }
    }
  } finally { await reader?.cancel().catch(() => {}); }
  return { status: response.status, headers, body: redactDiagnostic(new TextDecoder().decode(bytes), profile), body_truncated: truncated };
}
function configValue(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid curl proxy configuration.');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/** Real curl, fixed destination, profile credentials on stdin (never argv), no direct retry. */
export async function curlProfileIp(profile: AccountProxyProfile): Promise<ProxyDiagnostic> {
  const diagnostic = diagnosticStart(profile, 'https://2ip.io/', 'curl');
  diagnostic.request.headers['user-agent'] = 'curl/dario-proxy-check';
  const marker = `\n--dario-${diagnostic.trace_id}--`;
  const config = [
    'url = "https://2ip.io/"', 'dump-header = "-"', `proxy = ${configValue(profile.proxyUrl)}`,
    // Override NO_PROXY/no_proxy, and -q below disables any user curlrc.
    'noproxy = ""', 'silent', 'show-error', 'request = "GET"',
    'max-time = 15', 'connect-timeout = 8', 'max-redirs = 0', 'proto = "=https"',
    'header = "Accept: text/plain, text/html;q=0.9"', 'header = "Accept-Encoding: identity"',
    'user-agent = "curl/dario-proxy-check"',
    `write-out = ${configValue(marker.replace(/\n/g, '\\n') + '%{http_code}|%{remote_ip}|%{http_connect}')}`,
  ].join('\n') + '\n';
  const start = Date.now();
  const result = await new Promise<{code: number | null; output: string; error: string; truncated: boolean}>((resolve) => {
    const child = spawn('curl', ['-q', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    let size = 0, errorSize = 0, truncated = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 17000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { truncated = true; child.kill('SIGKILL'); return; }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (errorSize < 4096) errors.push(chunk.subarray(0, 4096 - errorSize)); errorSize += chunk.length; });
    child.stdin.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, output: '', error: error.code === 'ENOENT' ? 'curl is not installed in this container.' : 'Unable to start curl.', truncated: false });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(output).toString('utf8'), error: Buffer.concat(errors).toString('utf8'), truncated });
    });
    child.stdin.end(config);
  });
  const split = result.output.lastIndexOf(marker);
  let body = split >= 0 ? result.output.slice(0, split) : result.output;
  let responseHeaders: Record<string, string> = {};
  // curl emits CONNECT/interim headers before the final target response.
  while (/^HTTP\/[0-9.]+ [0-9]{3}/.test(body)) {
    const delimiter = body.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const end = body.indexOf(delimiter);
    if (end < 0) break;
    const headers = new Headers();
    for (const line of body.slice(0, end).split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    responseHeaders = {};
    for (const name of ['content-type', 'content-length', 'server', 'date', 'via', 'cf-ray', 'retry-after']) {
      const value = headers.get(name);
      if (value) responseHeaders[name] = redactDiagnostic(value.slice(0, 1024), profile);
    }
    body = body.slice(end + delimiter.length);
  }
  const [status, connectedIp, connectStatus] = split >= 0 ? result.output.slice(split + marker.length).trim().split('|') : [];
  const code = Number(status) || 0;
  diagnostic.duration_ms = Date.now() - start;
  diagnostic.curl_exit_code = result.code;
  diagnostic.proxy_reachable = result.code === 0 && code > 0;
  diagnostic.provider_accessible = result.code === 0 && code >= 200 && code < 300;
  diagnostic.response = code ? { status: code, headers: responseHeaders, body: redactDiagnostic(body.slice(0, BODY_LIMIT), profile), body_truncated: result.truncated || body.length > BODY_LIMIT, connected_ip: connectedIp, connect_status: Number(connectStatus) || 0 } : null;
  diagnostic.observed_ip = diagnostic.provider_accessible && isIP(body.trim()) ? body.trim() : null;
  if (result.code !== 0) diagnostic.error = redactDiagnostic(result.error.trim() || (result.truncated ? 'curl response exceeded the output limit.' : 'curl was interrupted or timed out.'), profile) + ' Direct fallback is disabled.';
  else if (!diagnostic.provider_accessible) diagnostic.error = `2ip.io returned HTTP ${code}; external IP was not confirmed.`;
  logProxyDiagnostic(diagnostic);
  return diagnostic;
}
