import { defaultSettings } from './settings';
import { invoke } from '@tauri-apps/api/core';

function isTauriRuntime() {
  return typeof window !== 'undefined' && (
    window.location.protocol === 'tauri:' ||
    window.location.hostname.endsWith('.tauri.localhost') ||
    '__TAURI_INTERNALS__' in window
  );
}

export function apiUrl(path: string, apiServerUrl = defaultSettings.apiServerUrl) {
  const base = apiServerUrl.trim().replace(/\/+$/, '');
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path;
}

export function shouldResolveManagedApiUrl(apiServerUrl: string, desktop: boolean) {
  const base = apiServerUrl.trim();
  return desktop && (!base || base === 'http://127.0.0.1:3001');
}

export function apiFetch(path: string, init?: RequestInit, apiServerUrl?: string) {
  const configuredBase = (apiServerUrl ?? defaultSettings.apiServerUrl).trim();
  if (!shouldResolveManagedApiUrl(configuredBase, isTauriRuntime())) return fetch(apiUrl(path, configuredBase), init);
  return invoke<string>('local_api_base_url').then((base) => fetch(apiUrl(path, base), init));
}
