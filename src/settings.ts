import type { AppSettings, ModelId, ProviderId, ReasoningEffort, UsageTotals } from './types';

export const SETTINGS_STORAGE_KEY = 'annotation-studio:settings:v1';
export const API_KEY_STORAGE_KEY = 'annotation-studio:api-key:v1';
export const USAGE_STORAGE_KEY = 'annotation-studio:usage:v1';

export const modelCatalog: Array<{ id: ModelId; label: string }> = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
];

function isTauriRuntime() {
  return typeof window !== 'undefined' && (
    window.location.protocol === 'tauri:' ||
    window.location.hostname.endsWith('.tauri.localhost') ||
    '__TAURI_INTERNALS__' in window
  );
}

export const defaultSettings: AppSettings = {
  apiServerUrl: import.meta.env?.VITE_API_BASE_URL?.trim() || (isTauriRuntime() ? 'http://127.0.0.1:3001' : ''),
  provider: 'openai-api',
  endpoint: 'https://api.openai.com/v1',
  azureDeployment: '',
  model: 'gpt-6-astra',
  reasoningEffort: 'medium',
};

export const emptyUsageTotals: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  totalTokens: 0,
  byModel: {},
};

function safeRead(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as unknown : null;
  } catch {
    return null;
  }
}

const providerIds: ProviderId[] = ['openai-api', 'azure-openai', 'openai-compatible', 'codex-app-server'];
const modelIds: ModelId[] = modelCatalog.map((entry) => entry.id);
const effortIds: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export function loadSettings(): AppSettings {
  const raw = safeRead(SETTINGS_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return defaultSettings;
  const value = raw as Partial<AppSettings>;
  return {
    apiServerUrl: typeof value.apiServerUrl === 'string' ? value.apiServerUrl : defaultSettings.apiServerUrl,
    provider: providerIds.includes(value.provider as ProviderId) ? value.provider as ProviderId : defaultSettings.provider,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : defaultSettings.endpoint,
    azureDeployment: typeof value.azureDeployment === 'string' ? value.azureDeployment : '',
    model: modelIds.includes(value.model as ModelId) ? value.model as ModelId : defaultSettings.model,
    reasoningEffort: effortIds.includes(value.reasoningEffort as ReasoningEffort) ? value.reasoningEffort as ReasoningEffort : defaultSettings.reasoningEffort,
  };
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadApiKey(storage: SettingsStorage = window.localStorage): string {
  try { storage.removeItem(API_KEY_STORAGE_KEY); } catch { /* Clear legacy plaintext secrets when storage is available. */ }
  return '';
}

export function loadUsageTotals(): UsageTotals {
  const raw = safeRead(USAGE_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return emptyUsageTotals;
  const value = raw as Partial<UsageTotals>;
  return { ...emptyUsageTotals, ...value, byModel: value.byModel ?? {} };
}

export function persistSettings(settings: AppSettings, storage: SettingsStorage = window.localStorage) {
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    storage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // Storage may be disabled; the in-memory settings still work for this session.
  }
}

export function persistUsageTotals(usage: UsageTotals) {
  try { localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage)); } catch { /* Keep this session's counters in memory. */ }
}

export function serviceUrl(path: string, apiServerUrl: string): string {
  const base = apiServerUrl.trim().replace(/\/+$/, '');
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path;
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat('ja-JP').format(value);
}
