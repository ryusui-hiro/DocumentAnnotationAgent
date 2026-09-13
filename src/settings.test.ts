import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppSettings } from './types';
import { API_KEY_STORAGE_KEY, SETTINGS_STORAGE_KEY, loadApiKey, persistSettings } from './settings';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('API keys remain memory-only and legacy plaintext keys are cleared', () => {
  const storage = memoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, 'sk-legacy-secret');
  assert.equal(loadApiKey(storage), '');
  assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null);

  const settings: AppSettings = {
    apiServerUrl: '', provider: 'openai-api', endpoint: 'https://api.openai.com/v1',
    azureDeployment: '', model: 'gpt-6-astra', reasoningEffort: 'medium',
  };
  persistSettings(settings, storage);
  assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null);
  assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}'), settings);
});
