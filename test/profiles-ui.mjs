import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { profilesUiPage } from '../dist/profiles-ui.js';

const page = profilesUiPage();
const blocks = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(blocks.length, 2);
for (const block of blocks) new Script(block);
const helper = runInNewContext(blocks[0] + ';DarioProfiles', { URL });
const url = new URL(helper.proxyUrl('http://proxy.example:8080', 'user@name', 'p@ss:#/word%100'));
assert.equal(decodeURIComponent(url.username), 'user@name');
assert.equal(decodeURIComponent(url.password), 'p@ss:#/word%100');
assert.equal(url.hostname, 'proxy.example');
assert.equal(new URL(helper.proxyUrl('https://u:p@proxy.example', '', '')).password, 'p');
for (const value of ['socks5://proxy.example:1080', 'http://proxy.example/path', 'javascript:alert(1)', 'garbage']) {
  assert.throws(() => helper.proxyUrl(value, '', ''));
}
assert.equal(helper.status({ enabled: false, authenticated: true }), 'Отключён');
assert.equal(helper.status({ enabled: true, loginPending: true }), 'Ожидает входа');
assert.equal(helper.status({ enabled: true, authenticated: true }), 'Авторизован');
assert.equal(helper.status({ enabled: true }), 'Нужен вход');
assert(!/localStorage|sessionStorage|innerHTML|document\.write/.test(blocks.join('\n')), 'admin token and profile fields must not enter storage or HTML injection sinks');
assert(!/<script[^>]*\bsrc=|<link[^>]*https?:|<img[^>]*https?:/.test(page), 'management page loads no external resources');
const dashboard = readFileSync(new URL('../dist/analytics-ui.html', import.meta.url), 'utf8');
assert(dashboard.includes('href="/profiles/ui"'));
assert(page.includes('http://127.0.0.1:6080/vnc.html'));
console.log('PASS: management UI scripts compile, proxy credentials round-trip safely, no persistent secrets, dashboard and noVNC links');
