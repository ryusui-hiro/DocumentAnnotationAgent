import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppSettings } from './types';
import { API_KEY_STORAGE_KEY, SETTINGS_STORAGE_KEY, LANGUAGE_STORAGE_KEY, loadApiKey, loadLanguage, persistLanguage, persistSettings } from './settings';

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

test('UI language persists independently of provider settings and defaults safely to English', () => {
  const storage = memoryStorage();
  assert.equal(loadLanguage(storage), 'en');
  for (const language of ['en', 'zh-CN', 'ja'] as const) {
    persistLanguage(language, storage);
    assert.equal(loadLanguage(storage), language);
  }
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
  storage.setItem(LANGUAGE_STORAGE_KEY, 'unsupported');
  assert.equal(loadLanguage(storage), 'en');
  const unavailableStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadLanguage(unavailableStorage), 'en');
  assert.doesNotThrow(() => persistLanguage('en', unavailableStorage));
});
