const defaultMaxUploadMegabytes = 30;
const maximumMaxUploadMegabytes = 100;
const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function maxUploadMegabytesFromEnvironment(value: string | undefined) {
  if (value === undefined || value.trim() === '') return defaultMaxUploadMegabytes;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultMaxUploadMegabytes;
  return Math.min(Math.max(Math.floor(parsed), 1), maximumMaxUploadMegabytes);
}

/** Allow explicitly configured origins and same-origin loopback UI requests only. */
export function isAllowedRequestOrigin(
  origin: string,
  requestHost: string | undefined,
  configuredOrigins: ReadonlySet<string>,
) {
  if (configuredOrigins.has(origin)) return true;
  if (!requestHost) return false;

  try {
    const originUrl = new URL(origin);
    if (!['http:', 'https:'].includes(originUrl.protocol)
      || originUrl.username
      || originUrl.password
      || originUrl.pathname !== '/'
      || originUrl.search
      || originUrl.hash) return false;

    const requestUrl = new URL(`http://${requestHost}`);
    return originUrl.host === requestUrl.host && localHostnames.has(originUrl.hostname.toLowerCase());
  } catch {
    return false;
  }
}
