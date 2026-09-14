import { tr } from './i18n';

export class ApiJsonResponseError extends Error {
  readonly status: number;
  constructor(response: Response, kind: 'empty' | 'invalid') {
    let path = '/api';
    try { path = new URL(response.url).pathname.slice(0, 120); } catch { /* Synthetic responses have no URL. */ }
    const values = { status: response.status, path };
    super(kind === 'empty'
      ? tr({ ja: 'サーバーから空の応答が返りました（HTTP {status}、{path}）。APIサーバーが動いているか確認してから、もう一度操作してください。', en: 'The server returned an empty response (HTTP {status}, {path}). Check that the API server is running, then try again.', 'zh-CN': '服务器返回了空响应（HTTP {status}，{path}）。请确认 API 服务器正在运行，然后重试。' }, values)
      : tr({ ja: 'サーバーの応答がJSONではないか、途中で切れています（HTTP {status}、{path}）。APIサーバーの接続を確認してください。', en: 'The server response is not valid JSON or was interrupted (HTTP {status}, {path}). Check the API server connection.', 'zh-CN': '服务器响应不是有效的 JSON，或传输已中断（HTTP {status}，{path}）。请检查 API 服务器连接。' }, values));
    this.name = 'ApiJsonResponseError';
    this.status = response.status;
  }
}

/** Read a JSON endpoint once, without replaying uploads/model calls or exposing HTML/credentials in errors. */
export async function readResponseJson<T = any>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body.trim()) throw new ApiJsonResponseError(response, 'empty');
  try { return JSON.parse(body) as T; }
  catch { throw new ApiJsonResponseError(response, 'invalid'); }
}
