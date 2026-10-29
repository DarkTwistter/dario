import assert from 'node:assert/strict';
import { browserCheckTimeoutMs } from '../dist/profile-browser.js';
const previous = process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES;
delete process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES;
try {
  assert.equal(browserCheckTimeoutMs(), 30 * 60_000);
  assert.equal(browserCheckTimeoutMs(''), 30 * 60_000);
  assert.equal(browserCheckTimeoutMs('60'), 60 * 60_000);
  assert.equal(browserCheckTimeoutMs(' 120 '), 120 * 60_000);
  assert.equal(browserCheckTimeoutMs('0'), 0);
  assert.equal(browserCheckTimeoutMs('1440'), 1440 * 60_000);
  for (const value of ['-1', '1.5', 'Infinity', '1441', 'no']) assert.throws(() => browserCheckTimeoutMs(value));
  process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES = '90';
  assert.equal(browserCheckTimeoutMs(), 90 * 60_000);
  console.log('PASS: default browser lifetime, configurable minutes, unlimited mode and invalid timeout rejection');
} finally {
  if (previous === undefined) delete process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES;
  else process.env.DARIO_BROWSER_CHECK_TIMEOUT_MINUTES = previous;
}
