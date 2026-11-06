// Exercise the default CLI login and account-add flows with a mock OAuth provider.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'dario-headless-'));
try {
  const preload = join(root, 'provider.mjs');
  await writeFile(preload, `
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
http.createServer = () => { throw new Error('OAuth must not start a callback listener'); };
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://example.invalid/token') {
    const body = JSON.parse(options.body);
    assert.equal(body.code, 'test-code');
    assert.equal(body.redirect_uri, 'https://platform.claude.com/oauth/code/callback');
    assert.equal(body.grant_type, 'authorization_code');
    assert.ok(body.code_verifier.length >= 43);
    return Response.json({access_token:'test-access', refresh_token:'test-refresh', expires_in:3600, scope:'user:inference'});
  }
  return new Response('', {status:404});
};
`);
  for (const args of [['login', '--force-reauth'], ['accounts', 'add', 'main']]) {
    const home = join(root, args[0]);
    await mkdir(home);
    let output = '', sent = false;
    const child = spawn(process.execPath, ['--import', preload, resolve('dist/cli.js'), ...args], {
      env: { ...process.env, HOME: home, DARIO_NO_BUN:'1', DARIO_IGNORE_CC_CREDENTIALS:'1',
        DARIO_OAUTH_CLIENT_ID:'test-client', DARIO_OAUTH_AUTHORIZE_URL:'https://example.invalid/authorize',
        DARIO_OAUTH_TOKEN_URL:'https://example.invalid/token', DARIO_OAUTH_SCOPES:'user:inference' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!sent && output.includes('Code: ')) {
        const match = output.match(/https:\/\/example\.invalid\/authorize\?[^\s]+/);
        assert.ok(match, output);
        const url = new URL(match[0]);
        assert.equal(url.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        sent = true;
        child.stdin.end('test-code#' + url.searchParams.get('state') + '\n');
      }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.ok(sent, output);
    const path = args[0] === 'login' ? join(home, '.dario', 'credentials.json') : join(home, '.dario', 'accounts', 'main.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((saved.claudeAiOauth ?? saved).accessToken, 'test-access');
    console.log('PASS', args.join(' '), 'accepts pasted code, saves tokens, exits without a listener');
  }
} finally {
  await rm(root, {recursive:true, force:true});
}
