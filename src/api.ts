import { defaultSettings } from './settings';

export function apiUrl(path: string, apiServerUrl = defaultSettings.apiServerUrl) {
  const base = apiServerUrl.trim().replace(/\/+$/, '');
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path;
}

export function apiFetch(path: string, init?: RequestInit, apiServerUrl?: string) {
  return fetch(apiUrl(path, apiServerUrl), init);
}
