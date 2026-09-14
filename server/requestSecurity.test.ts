import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedRequestOrigin, maxUploadMegabytesFromEnvironment } from './requestSecurity';

test('upload-size configuration always produces a finite bounded limit', () => {
  assert.equal(maxUploadMegabytesFromEnvironment(undefined), 30);
  assert.equal(maxUploadMegabytesFromEnvironment(''), 30);
  assert.equal(maxUploadMegabytesFromEnvironment('not-a-number'), 30);
  assert.equal(maxUploadMegabytesFromEnvironment('Infinity'), 30);
  assert.equal(maxUploadMegabytesFromEnvironment('NaN'), 30);
  assert.equal(maxUploadMegabytesFromEnvironment('0'), 1);
  assert.equal(maxUploadMegabytesFromEnvironment('-8'), 1);
  assert.equal(maxUploadMegabytesFromEnvironment('12'), 12);
  assert.equal(maxUploadMegabytesFromEnvironment('140'), 100);
});

test('same-origin CORS fallback is limited to loopback hosts', () => {
  const configured = new Set<string>();
  assert.equal(isAllowedRequestOrigin('http://127.0.0.1:3001', '127.0.0.1:3001', configured), true);
  assert.equal(isAllowedRequestOrigin('http://localhost:3001', 'localhost:3001', configured), true);
  assert.equal(isAllowedRequestOrigin('http://[::1]:3001', '[::1]:3001', configured), true);

  // A DNS-rebinding page can make an attacker hostname resolve to loopback and
  // send the same Host header. Host equality alone must not grant CORS access.
  assert.equal(isAllowedRequestOrigin('http://attacker.example:3001', 'attacker.example:3001', configured), false);
  assert.equal(isAllowedRequestOrigin('http://127.0.0.1:3001', 'attacker.example:3001', configured), false);
});

test('configured deployment origins remain explicit and malformed origins are rejected', () => {
  const configured = new Set(['https://review.example.com']);
  assert.equal(isAllowedRequestOrigin('https://review.example.com', 'api.example.com', configured), true);
  assert.equal(isAllowedRequestOrigin('https://other.example.com', 'other.example.com', configured), false);
  assert.equal(isAllowedRequestOrigin('null', 'localhost:3001', configured), false);
  assert.equal(isAllowedRequestOrigin('https://user@localhost:3001', 'localhost:3001', configured), false);
});
