import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { paperOcrOutputSchema, parsePaperOcrOutput, runPaperOcrWithCodex, runPaperOcrWithOpenAI } from './paperOcr';

const fixture = { blocks: [{ type: 'equation', bbox: { x: 0.5, y: 0.6, width: 0.4, height: 0.05 }, extractedText: 'a² + b² = c²', latex: 'a^2 + b^2 = c^2', uncertain: false, uncertaintyReason: '' }], warnings: [] };
const input = { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', pageNumber: 2, sourcePageNumber: 5, model: 'gpt-6-astra', reasoningEffort: 'medium' };

test('paper OCR parser rejects invalid classifications and out-of-page regions', () => {
  assert.throws(() => parsePaperOcrOutput(JSON.stringify({ ...fixture, blocks: [{ ...fixture.blocks[0], type: 'invented' }] }), 2));
  assert.throws(() => parsePaperOcrOutput(JSON.stringify({ ...fixture, blocks: [{ ...fixture.blocks[0], bbox: { x: 0.8, y: 0.4, width: 0.4, height: 0.1 } }] }), 2), /outside the page/);
  assert.throws(() => parsePaperOcrOutput(JSON.stringify({ ...fixture, blocks: [{ ...fixture.blocks[0], type: 'text' }] }), 2), /non-equation/);
  const result = parsePaperOcrOutput(JSON.stringify(fixture), 2);
  assert.equal(result.blocks[0]?.id, 'paper-p2-b1');
  assert.equal(result.blocks[0]?.latex, fixture.blocks[0]?.latex);
});

test('paper OCR uses the real OpenAI SDK with image input, strict output, no response storage, and explicit deployment', async () => {
  let captured: Record<string, unknown> | undefined;
  let incomplete = false;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    captured = JSON.parse(raw);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'resp_fixture', object: 'response', created_at: 1, status: incomplete ? 'incomplete' : 'completed',
      model: 'deployment-fixture', output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(fixture), annotations: [] }] }],
      usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300, input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 20 } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new OpenAI({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
  try {
    const result = await runPaperOcrWithOpenAI({ ...input, client, deployment: 'deployment-fixture', provider: 'azure-openai' });
    assert.equal(result.pageNumber, 2);
    assert.equal(result.sourcePageNumber, 5);
    assert.equal(result.model, 'gpt-6-astra');
    assert.equal(result.usage.totalTokens, 300);
    assert.equal(result.provider, 'azure-openai');
    assert.equal(captured?.store, false);
    assert.equal(captured?.model, 'deployment-fixture');
    assert.deepEqual(captured?.text, { format: { type: 'json_schema', name: 'paper_page_ocr', strict: true, schema: paperOcrOutputSchema } });
    assert.match(String(captured?.instructions), /untrusted document data/);
    assert.deepEqual(captured?.input, [{ role: 'user', content: [{ type: 'input_image', image_url: input.imageDataUrl, detail: 'high' }] }]);
    incomplete = true;
    await assert.rejects(runPaperOcrWithOpenAI({ ...input, client }), /did not complete/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('paper OCR Codex path returns source mapping and usage and removes its temporary image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-ocr-codex-test-'));
  const binary = join(directory, 'fake.cjs');
  const capture = join(directory, 'capture.json');
  const previousBinary = process.env.CODEX_APP_SERVER_BIN;
  try {
    await writeFile(binary, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'ocr-thread' } } });
  if (request.method === 'turn/start') {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: 'ocr-turn' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'ocr-thread', tokenUsage: { last: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } } });
    send({ method: 'turn/completed', params: { threadId: 'ocr-thread', turn: { id: 'ocr-turn', status: 'completed', items: [{ type: 'agentMessage', text: ${JSON.stringify(JSON.stringify(fixture))} }] } } });
  }
});
`, { mode: 0o755 });
    process.env.CODEX_APP_SERVER_BIN = binary;
    const result = await runPaperOcrWithCodex(input);
    assert.equal(result.sourcePageNumber, 5);
    assert.equal(result.usage.totalTokens, 30);
    const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(request.outputSchema, paperOcrOutputSchema);
    assert.equal(request.model, 'gpt-6-astra');
    await assert.rejects(readFile(request.input[1].path), /ENOENT/);
  } finally {
    if (previousBinary === undefined) delete process.env.CODEX_APP_SERVER_BIN;
    else process.env.CODEX_APP_SERVER_BIN = previousBinary;
    await rm(directory, { recursive: true, force: true });
  }
});
