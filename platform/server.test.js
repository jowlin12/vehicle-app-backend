'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('standalone platform server does not load the operational workshop', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'platform-server.js'),
    'utf8',
  );
  assert.match(source, /require\('\.\/platform'\)/);
  assert.doesNotMatch(source, /require\('\.\/database/);
  assert.doesNotMatch(source, /require\('\.\/facturatech/);
  assert.match(source, /app\.get\('\/health'/);
});
