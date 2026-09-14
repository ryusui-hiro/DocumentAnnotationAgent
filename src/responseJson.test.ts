import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiJsonResponseError, readResponseJson } from './responseJson';
import { setLanguage } from './i18n';

test('JSON reader preserves source strings and valid server errors', async () => {
  const body = { text: '本文 {\"user\":true} 中文', error: 'A model error', values: [1, null] };
  assert.deepEqual(await readResponseJson(new Response(JSON.stringify(body), { status: 422 })), body);
});

test('empty and truncated responses explain the server problem instead of leaking a SyntaxError', async () => {
  setLanguage('en');
  for (const [body, status, expected] of [['', 200, /empty response.*HTTP 200/], ['   ', 502, /empty response.*HTTP 502/], ['{"error":', 500, /not valid JSON or was interrupted/]] as const) {
    await assert.rejects(readResponseJson(new Response(body, { status })), (error: unknown) => error instanceof ApiJsonResponseError && error.status === status && expected.test(error.message));
  }
});

test('HTML and URL credentials are not copied into visible errors, and messages localize', async () => {
  const response = new Response('<html>SECRET_DIAGNOSTIC_TOKEN</html>', { status: 502 });
  Object.defineProperty(response, 'url', { value: 'https://user:password@example.test/api/convert?key=secret' });
  try {
    setLanguage('ja');
    await assert.rejects(readResponseJson(response), (error: unknown) => error instanceof Error && error.message.includes('JSONではない') && error.message.includes('/api/convert') && !/SECRET|password|key=|secret/.test(error.message));
    setLanguage('zh-CN');
    await assert.rejects(readResponseJson(new Response('')), /空响应/);
  } finally { setLanguage('en'); }
});
