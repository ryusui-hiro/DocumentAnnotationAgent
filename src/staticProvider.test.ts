import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStaticEndpoint, runStaticIntent, staticClientOptions, staticTestConnection, type StaticProviderSettings } from './staticProvider';
import type { PaperBlock } from './paperOcrTypes';

const settings: StaticProviderSettings = { apiServerUrl: '', provider: 'openai-api', endpoint: 'https://api.example.test/v1', apiKey: 'user-session-fixture-key', azureDeployment: '', model: 'gpt-6-astra', reasoningEffort: 'medium' };
const block = { type: 'region', label: 'Exact Label', note: 'Visible supporting evidence.', bbox: { x: .1, y: .2, width: .3, height: .1 }, extractedText: 'Evidence', latex: null, uncertain: false, uncertaintyReason: '' };
const input = { imageDataUrl: 'data:image/png;base64,aGVsbG8=', instruction: 'Mark the evidence as Exact Label.', pageNumber: 2, sourcePageNumber: 5, labelRules: [{ name: 'Exact Label', description: 'Visible evidence only.' }], settings };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function streamFixture(options: { finish?: Promise<void>; status?: 'completed' | 'incomplete'; finalBlock?: typeof block } = {}) {
  const base = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'in_progress', output: [] };
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
  return new Response(new ReadableStream({
    async start(controller) {
      let sequence = 0;
      const send = (value: Record<string, unknown>) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`));
      send({ type: 'response.created', response: base });
      send({ type: 'response.output_item.added', output_index: 0, item: message });
      send({ type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: JSON.stringify({ blocks: [block], warnings: [] }), logprobs: [] });
      await options.finish;
      const finalText = JSON.stringify({ blocks: [options.finalBlock ?? block], warnings: [] });
      const finalMessage = { ...message, status: 'completed', content: [{ type: 'output_text', text: finalText, annotations: [] }] };
      send({ type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text: finalText, logprobs: [] });
      send({ type: 'response.output_item.done', output_index: 0, item: finalMessage });
      const status = options.status ?? 'completed';
      send({ type: `response.${status}`, response: { ...base, status, output: [finalMessage], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } } });
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('browser client requires explicit credentials and HTTPS and disables persistence/redirect credentials', () => {
  const config = staticClientOptions(settings);
  assert.equal(config.apiKey, settings.apiKey);
  assert.equal(config.baseURL, 'https://api.example.test/v1/');
  assert.equal(config.dangerouslyAllowBrowser, true);
  assert.equal(config.maxRetries, 0);
  assert.deepEqual(config.fetchOptions, { credentials: 'omit', redirect: 'error' });
  assert.equal(config.organization, null);
  assert.equal(config.project, null);
  assert.equal(config.adminAPIKey, null);
  assert.throws(() => staticClientOptions({ ...settings, apiKey: '' }), /Enter your API key/);
  assert.throws(() => staticClientOptions({ ...settings, provider: 'codex-app-server' }), /external document API server/);
  assert.throws(() => staticClientOptions({ ...settings, provider: 'azure-openai' }), /deployment name/);
  for (const endpoint of ['http://localhost:3000/v1', 'https://key@example.test', 'https://example.test?key=secret', 'https://example.test/#secret']) {
    assert.throws(() => normalizeStaticEndpoint(endpoint, 'openai-api'));
  }
  assert.equal(normalizeStaticEndpoint('https://azure.example.test/', 'azure-openai'), 'https://azure.example.test/openai/v1/');
  assert.equal(normalizeStaticEndpoint('https://azure.example.test/openai/', 'azure-openai'), 'https://azure.example.test/openai/v1/');
  assert.equal(normalizeStaticEndpoint('https://azure.example.test/openai/v1/', 'azure-openai'), 'https://azure.example.test/openai/v1/');
});

test('static annotation uses real SDK streaming with a frozen image and binding labels, then replaces provisional findings', { timeout: 5000 }, async () => {
  const first = deferred();
  const finish = deferred();
  const seen: PaperBlock[] = [];
  let requestBody: Record<string, unknown> | undefined;
  let finished = false;
  const mutable = { ...input, settings: { ...settings }, labelRules: input.labelRules.map(rule => ({ ...rule })) };
  const running = runStaticIntent({ ...mutable, onBlock: value => { seen.push(value); first.resolve(); } }, { fetch: async (url, request) => {
    assert.equal(String(url), 'https://api.example.test/v1/responses');
    assert.equal(new Headers(request?.headers).get('authorization'), `Bearer ${settings.apiKey}`);
    assert.equal(request?.credentials, 'omit');
    assert.equal(request?.redirect, 'error');
    requestBody = JSON.parse(String(request?.body));
    return streamFixture({ finish: finish.promise, finalBlock: { ...block, note: 'Final checked evidence.' } });
  } }).finally(() => { finished = true; });
  mutable.settings.apiKey = 'later-changed-key';
  mutable.labelRules[0]!.name = 'Later changed label';
  try {
    await first.promise;
    assert.equal(finished, false);
    assert.equal(seen[0]?.provisional, true);
    assert.equal(seen[0]?.source, 'ai');
    assert.equal(requestBody?.store, false);
    assert.equal(requestBody?.stream, true);
    assert.match(String(requestBody?.instructions), /Exact Label/);
    assert.doesNotMatch(String(requestBody?.instructions), /Later changed label/);
    assert.deepEqual(requestBody?.input, [{ role: 'user', content: [{ type: 'input_image', image_url: input.imageDataUrl, detail: 'high' }] }]);
    finish.resolve();
    const result = await running;
    assert.equal(result.status, 'complete');
    assert.equal(result.pageNumber, 2);
    assert.equal(result.sourcePageNumber, 5);
    assert.equal(result.blocks[0]?.note, 'Final checked evidence.');
    assert.equal(result.blocks[0]?.provisional, false);
    assert.equal(result.usage?.totalTokens, 150);
  } finally { finish.resolve(); }
});

test('incomplete or invalid finals never become complete and pre-aborted pages never contact the provider', async () => {
  const phases: string[] = [];
  await assert.rejects(runStaticIntent({ ...input, onActivity: activity => phases.push(activity.phase) }, { fetch: async () => streamFixture({ status: 'incomplete' }) }), /did not complete/);
  assert.equal(phases.includes('complete'), false);
  await assert.rejects(runStaticIntent(input, { fetch: async () => streamFixture({ finalBlock: { ...block, label: 'Unexpected label' } }) }), /outside the supplied rules/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runStaticIntent({ ...input, signal: controller.signal }, { fetch: async () => { assert.fail('aborted request contacted provider'); } }), /abort/i);
});

test('Azure sends the explicitly selected deployment to its v1 Responses endpoint', async () => {
  const azure = { ...settings, provider: 'azure-openai' as const, endpoint: 'https://azure.example.test', azureDeployment: 'my-vision-deployment' };
  const result = await runStaticIntent({ ...input, settings: azure }, { fetch: async (url, request) => {
    assert.equal(String(url), 'https://azure.example.test/openai/v1/responses');
    assert.equal(JSON.parse(String(request?.body)).model, 'my-vision-deployment');
    return streamFixture();
  } });
  assert.equal(result.provider, 'azure-openai');
});

test('connection check is read-only and CORS/authentication failures are actionable without exposing credentials', async () => {
  const result = await staticTestConnection(settings, settings.model, undefined, { fetch: async (url, request) => {
    assert.equal(String(url), 'https://api.example.test/v1/models');
    assert.equal(request?.method, 'GET');
    assert.equal(request?.body, undefined);
    return Response.json({ object: 'list', data: [] });
  } });
  assert.equal(result.ok, true);
  assert.match(result.message, /checked when you run a page/);
  await assert.rejects(staticTestConnection(settings, settings.model, undefined, { fetch: async () => { throw new TypeError('Failed to fetch'); } }), /CORS/);
  await assert.rejects(staticTestConnection(settings, settings.model, undefined, { fetch: async () => Response.json({ error: { message: `bad key ${settings.apiKey}` } }, { status: 401 }) }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /provider rejected the API key/i);
    assert.equal(error.message.includes(settings.apiKey), false);
    return true;
  });
});
