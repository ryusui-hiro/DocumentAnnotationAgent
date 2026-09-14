export const STATIC_BUILD = import.meta.env?.VITE_STATIC_BUILD === 'true';
export function usesBrowserRuntime(apiServerUrl = '') { return STATIC_BUILD && !apiServerUrl.trim(); }
export function assetUrl(path: string) {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${import.meta.env?.BASE_URL || '/'}${path.replace(/^\/+/, '')}`;
}
