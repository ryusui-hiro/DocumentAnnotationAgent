import assert from 'node:assert/strict';
import test from 'node:test';
import { apiUrl, shouldResolveManagedApiUrl } from './api';

test('only the blank desktop URL selects the managed local API; configured custom endpoints stay direct', () => {
  assert.equal(shouldResolveManagedApiUrl('', true), true);
  assert.equal(shouldResolveManagedApiUrl('  ', true), true);
  assert.equal(shouldResolveManagedApiUrl('https://annotation-api.example.com', true), false);
  assert.equal(shouldResolveManagedApiUrl('http://127.0.0.1:4300', true), false);
  assert.equal(shouldResolveManagedApiUrl('', false), false);
  assert.equal(shouldResolveManagedApiUrl('http://127.0.0.1:3001', true), true);
  assert.equal(apiUrl('/api/health', 'https://annotation-api.example.com'), 'https://annotation-api.example.com/api/health');
});
