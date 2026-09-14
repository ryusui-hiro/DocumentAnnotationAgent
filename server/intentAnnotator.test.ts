import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { IntentBlockStream, intentAnnotationPrompt, parseIntentAnnotationOutput, runIntentAnnotationWithCodex, runIntentAnnotationWithOpenAI, type IntentAnnotationBlock } from './intentAnnotator';

const block = { type: 'region', label: 'Custom target', note: 'Only the requested area.', bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, extractedText: 'Evidence', latex: null, uncertain: false, uncertaintyReason: '' };
const input = { instruction: 'Label only the requested area as Custom target.', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', pageNumber: 2, sourcePageNumber: 5, model: 'gpt-6-astra', reasoningEffort: 'low', labelRules: [{ name: 'Custom target', description: 'Only the specific region named by the user.' }] };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeout = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Test gate timed out.')), timeout); })]); }
  finally { clearTimeout(timer); }
}

test('incremental parser handles every chunk boundary, escaped braces, quotes, backslashes, and Unicode', () => {
  const special = { ...block, label: 'Research 🧪', note: 'Literal { nested [ text ] } and "quotes".', extractedText: '日本語\\path\nλ = "value"; } , { "blocks": []' };
  const encoded = JSON.stringify({ warnings: ['Earlier root property: {"blocks":[]}'], blocks: [special, { ...block, label: 'Second' }] });
  const expected = parseIntentAnnotationOutput(encoded, 2);
  for (const chunkSize of [1, 2, 3, 7, 19, encoded.length]) {
    const events: IntentAnnotationBlock[] = [];
    const scanner = new IntentBlockStream(2, (value) => events.push(value));
    for (let offset = 0; offset < encoded.length; offset += chunkSize) scanner.push(encoded.slice(offset, offset + chunkSize));
    assert.deepEqual(events, expected.blocks, `chunk size ${chunkSize}`);
    assert.deepEqual(scanner.finish(encoded), expected);
    assert.equal(events.length, 2, 'Identical final objects must not be duplicated.');
  }
});

test('parser emits nothing for incomplete strings or objects, nested blocks keys, or invalid boxes', () => {
  const events: IntentAnnotationBlock[] = [];
  const scanner = new IntentBlockStream(2, (value) => events.push(value));
  const first = JSON.stringify(block);
  scanner.push(`{"warnings":["{\\"blocks\\":[]}"],"blocks":[${first.slice(0, -1)}`);
  assert.equal(events.length, 0);
  scanner.push('}');
  assert.equal(events.length, 1, 'Only the complete validated block can be emitted.');
  scanner.push(`,${JSON.stringify({ ...block, bbox: { x: 0.9, y: 0.2, width: 0.3, height: 0.1 } })}`);
  assert.equal(events.length, 1, 'Out-of-page regions must not reach the viewer.');
  assert.throws(() => scanner.finish(`{"blocks":[${first}`));
  const nested: IntentAnnotationBlock[] = [];
  new IntentBlockStream(2, (value) => nested.push(value)).push(JSON.stringify({ other: { blocks: [block] }, blocks: [] }));
  assert.deepEqual(nested, []);
  const invalid: IntentAnnotationBlock[] = [];
  new IntentBlockStream(2, (value) => invalid.push(value)).push(`{"blocks":[false,${first}]}`);
  assert.deepEqual(invalid, []);
});

test('final response is authoritative and removes or corrects provisional objects', () => {
  const events: IntentAnnotationBlock[] = [];
  const scanner = new IntentBlockStream(2, (value) => events.push(value));
  scanner.push(JSON.stringify({ blocks: [block, { ...block, label: 'Removed later' }], warnings: [] }));
  const finalText = JSON.stringify({ blocks: [{ ...block, label: 'Corrected in final', note: 'Authoritative final note.' }], warnings: ['Second region was omitted.'] });
  const final = scanner.finish(finalText);
  assert.deepEqual(final, parseIntentAnnotationOutput(finalText, 2));
  assert.equal(final.blocks.length, 1);
  assert.equal(events.at(-1)?.label, 'Corrected in final');
  assert.throws(() => parseIntentAnnotationOutput(JSON.stringify({ blocks: [{ ...block, bbox: { x: 1, y: 0.2, width: 1e-12, height: 0.1 } }], warnings: [] }), 2), /no visible area/);
  assert.throws(() => parseIntentAnnotationOutput(JSON.stringify({ blocks: [{ ...block, bbox: { x: -0.1, y: 0.2, width: 0.3, height: 0.1 } }], warnings: [] }), 2));
});

test('intent prompt preserves user scope rather than prescribing mandatory OCR', () => {
  const prompt = intentAnnotationPrompt('Mark only the company seal as APPROVAL.');
  assert.match(prompt, /do not automatically perform whole-page OCR/);
  assert.match(prompt, /Mark only the company seal as APPROVAL\./);
  assert.match(prompt, /untrusted source data/);
  assert.match(prompt, /English labels and notes/);
});

test('real OpenAI SDK streaming emits a complete region before final response and rejects incomplete/aborted runs', { timeout: 10000 }, async () => {
  const partialSent = deferred();
  const closeFirstBlock = deferred();
  const firstBlock = deferred<IntentAnnotationBlock>();
  const completeResponse = deferred();
  const abortedRequest = deferred();
  let requestCount = 0;
  let captured: Record<string, unknown> | undefined;
  let mode: 'gated' | 'incomplete' | 'empty' | 'abort' = 'gated';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    captured = JSON.parse(raw); requestCount += 1;
    const activeMode = mode;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let sequence = 0;
    const send = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
    const base = { id: 'resp_stream_fixture', object: 'response', created_at: 1, model: 'fixture-deployment', status: 'in_progress', output: [] };
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    send({ type: 'response.created', response: base });
    send({ type: 'response.output_item.added', output_index: 0, item: message });
    send({ type: 'response.content_part.added', output_index: 0, item_id: 'msg_fixture', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    const encodedBlock = JSON.stringify(block);
    const delta = (text: string) => send({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_fixture', content_index: 0, delta: text, logprobs: [] });
    delta(`{"blocks":[${encodedBlock.slice(0, -1)}`);
    if (activeMode === 'gated') { partialSent.resolve(); await closeFirstBlock.promise; }
    if (activeMode === 'abort') { abortedRequest.resolve(); return; }
    delta('}');
    if (activeMode === 'gated') await completeResponse.promise;
    delta('],"warnings":[]}');
    const finalText = activeMode === 'empty' ? '' : JSON.stringify({ blocks: [block], warnings: [] });
    const finalMessage = { ...message, status: 'completed', content: [{ type: 'output_text', text: finalText, annotations: [] }] };
    send({ type: 'response.output_text.done', output_index: 0, item_id: 'msg_fixture', content_index: 0, text: finalText, logprobs: [] });
    send({ type: 'response.output_item.done', output_index: 0, item: finalMessage });
    send({ type: activeMode === 'incomplete' ? 'response.incomplete' : 'response.completed', response: { ...base, status: activeMode === 'incomplete' ? 'incomplete' : 'completed', output: [finalMessage], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new OpenAI({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
  const controller = new AbortController();
  try {
    const seen: IntentAnnotationBlock[] = [];
    let finished = false;
    const running = runIntentAnnotationWithOpenAI({ ...input, client, deployment: 'fixture-deployment', onBlock: (value) => { seen.push(value); firstBlock.resolve(value); } }).finally(() => { finished = true; });
    await bounded(partialSent.promise);
    assert.equal(seen.length, 0);
    closeFirstBlock.resolve();
    await bounded(firstBlock.promise);
    assert.equal(finished, false, 'A block must reach the caller while the provider still holds the final response.');
    assert.equal(seen.length, 1);
    completeResponse.resolve();
    const result = await bounded(running);
    assert.deepEqual(result.blocks, seen);
    assert.equal(result.sourcePageNumber, 5);
    assert.equal(result.model, 'gpt-6-astra');
    assert.equal(result.usage.totalTokens, 150);
    assert.equal(captured?.stream, true);
    assert.equal(captured?.store, false);
    assert.equal(captured?.model, 'fixture-deployment');
    assert.deepEqual((captured?.text as { format: { schema: { properties: { blocks: { items: { properties: { label: { enum: string[] } } } } } } } }).format.schema.properties.blocks.items.properties.label.enum, ['Custom target']);

    mode = 'incomplete';
    const activities: string[] = [];
    await assert.rejects(runIntentAnnotationWithOpenAI({ ...input, client, onActivity: (activity) => activities.push(activity.phase) }), /did not complete/);
    assert.equal(activities.includes('complete'), false);
    mode = 'empty';
    await assert.rejects(runIntentAnnotationWithOpenAI({ ...input, client }), /model returned empty or invalid annotation JSON/);
    mode = 'abort';
    const aborted = runIntentAnnotationWithOpenAI({ ...input, client, signal: controller.signal });
    void aborted.catch(() => undefined);
    await bounded(abortedRequest.promise);
    controller.abort();
    await assert.rejects(bounded(aborted), /abort/i);
    const before = requestCount;
    await assert.rejects(runIntentAnnotationWithOpenAI({ ...input, client, signal: controller.signal }), /abort/i);
    assert.equal(requestCount, before, 'Pre-aborted runs must not contact the provider.');
  } finally {
    closeFirstBlock.resolve(); completeResponse.resolve(); controller.abort(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Codex deltas emit validated blocks before completion, ignore commentary, and retain final authority', { timeout: 7000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intent-codex-stream-'));
  const binary = join(directory, 'fake.cjs');
  const capturePath = join(directory, 'turn.json');
  const gatePath = join(directory, 'release');
  const previousBinary = process.env.CODEX_APP_SERVER_BIN;
  const controller = new AbortController();
  const firstBlock = deferred();
  const seen: IntentAnnotationBlock[] = [];
  let running: Promise<unknown> | undefined;
  try {
    const finalText = JSON.stringify({ blocks: [block], warnings: [] });
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.method==='initialize') send({id:request.id,result:{}});
 if(request.method==='thread/start') send({id:request.id,result:{thread:{id:'thread'}}});
 if(request.method==='turn/start') {
  fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify(request.params));
  send({id:request.id,result:{turn:{id:'turn'}}});
  send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'commentary',type:'agentMessage',phase:'commentary'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'commentary',delta:${JSON.stringify(JSON.stringify({ blocks: [{ ...block, label: 'Must not emit' }], warnings: [] }))}}});
  send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',phase:'final_answer'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta:${JSON.stringify(`{"blocks":[${JSON.stringify(block)}`)}}});
  fs.watchFile(${JSON.stringify(gatePath)},{interval:10},()=>{
   if(!fs.existsSync(${JSON.stringify(gatePath)})) return;
   fs.unwatchFile(${JSON.stringify(gatePath)});
   send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta:'],"warnings":[]}'}});
   send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{last:{inputTokens:50,outputTokens:20,totalTokens:70}}}});
   send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',text:${JSON.stringify(finalText)}}]}}});
  });
 }
});
`, { mode: 0o755 });
    process.env.CODEX_APP_SERVER_BIN = binary;
    let finished = false;
    running = runIntentAnnotationWithCodex({ ...input, signal: controller.signal, onBlock: (value) => { seen.push(value); firstBlock.resolve(); } }).finally(() => { finished = true; });
    void running.catch(() => undefined);
    await bounded(firstBlock.promise);
    assert.equal(finished, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.label, 'Custom target');
    await writeFile(gatePath, 'continue');
    const result = await bounded(running) as Awaited<ReturnType<typeof runIntentAnnotationWithCodex>>;
    assert.deepEqual(result.blocks, seen);
    assert.equal(result.usage.totalTokens, 70);
    const sent = JSON.parse(await readFile(capturePath, 'utf8'));
    assert.deepEqual(sent.outputSchema.properties.blocks.items.properties.label.enum, ['Custom target']);
    await assert.rejects(readFile(sent.input[1].path), /ENOENT/);
  } finally {
    controller.abort(); await running?.catch(() => undefined);
    if (previousBinary === undefined) delete process.env.CODEX_APP_SERVER_BIN; else process.env.CODEX_APP_SERVER_BIN = previousBinary;
    await rm(directory, { recursive: true, force: true });
  }
});
