import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function availablePort() {
  const probe = createPortProbe();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startApi(port, dataDirectory) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test', AI_PROVIDER: 'openai',
      OPENAI_API_KEY: '', OPENAI_BASE_URL: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
      CODEX_APP_SERVER_DISABLED: 'true', ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-5000); });
  return { child, get output() { return output; } };
}

async function waitForApi(url, api) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`API exited: ${api.output}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API did not become ready: ${api.output}`);
}

async function stopApi(api) {
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) return;
  api.child.kill('SIGTERM');
  let timer;
  await Promise.race([new Promise((resolve) => api.child.once('exit', resolve)), new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
  clearTimeout(timer);
  if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
}

async function collectSse(response, onEvent = () => {}) {
  const decoder = new TextDecoder();
  let pending = '';
  const events = [];
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (event && data) { const item = { event, data: JSON.parse(data) }; events.push(item); onEvent(item); }
    }
  }
  return events;
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function bounded(promise, timeout = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Streaming test gate timed out.')), timeout); })]); }
  finally { clearTimeout(timer); }
}

test('paper OCR API binds real demo source pages and images, rejects invalid requests, and releases its run lock', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-ocr-api-test-'));
  const captured = [];
  const fixture = { blocks: [{ type: 'text', bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, extractedText: 'Loopback test result', latex: null, uncertain: false, uncertaintyReason: '' }], warnings: [] };
  let mode = 'complete';
  let release;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    captured.push(JSON.parse(raw));
    const responseMode = mode;
    if (responseMode === 'hold') await new Promise((resolve) => { release = resolve; });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'resp_paper_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: responseMode === 'incomplete' ? 'incomplete' : 'completed',
      output: [{ id: 'msg_paper_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(fixture), annotations: [] }] }],
      usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  let api;
  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    api = startApi(port, join(directory, 'state'));
    await waitForApi(baseUrl, api);
    const demoResponse = await fetch(`${baseUrl}/api/demo/paper-ocr`);
    assert.equal(demoResponse.status, 200);
    assert.match(demoResponse.headers.get('cache-control'), /no-store/);
    const demo = await demoResponse.json();
    assert.deepEqual(demo.paper.sourcePages, [1, 2, 5]);
    assert.deepEqual(demo.pages.map((page) => page.sourcePageNumber), [1, 2, 5]);
    assert.equal(demo.provenance.complete, true);
    assert.equal(demo.document.pageCount, 3);
    assert.equal(demo.document.sourceHash, digest(await readFile(join(root, 'public/demos/openai-paper-selected.pdf'))));
    const repeated = await (await fetch(`${baseUrl}/api/demo/paper-ocr`)).json();
    assert.equal(repeated.document.documentId, demo.document.documentId, 'A loaded demo session should be reused.');
    assert.equal(captured.length, 0, 'Opening stored real model results must never trigger a provider call.');

    const pageUrl = `${baseUrl}/api/documents/${demo.document.documentId}/pages/3.svg`;
    const sourceSvg = await (await fetch(pageUrl)).text();
    const sourceImage = sourceSvg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    assert.ok(sourceImage);
    assert.equal(digest(Buffer.from(sourceImage[1], 'base64')), demo.provenance.imageSha256[2]);
    const settings = { provider: 'openai-compatible', endpoint, apiKey: 'fixture-only', reasoningEffort: 'low' };
    const valid = { documentId: demo.document.documentId, pageNumber: 3, instruction: 'Read this page exactly.', model: 'gpt-6-astra', settings };
    const post = (body) => fetch(`${baseUrl}/api/ai/paper-ocr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const pageNumber of [undefined, 0, -1, 4, 1.5, '1', null]) assert.equal((await post({ ...valid, pageNumber })).status, 400);
    assert.equal((await post({ ...valid, documentId: undefined })).status, 400);
    assert.equal((await post({ ...valid, documentId: 'missing-session' })).status, 410);
    assert.equal((await post({ ...valid, instruction: '' })).status, 400);
    assert.equal((await post({ ...valid, instruction: 'x'.repeat(2001) })).status, 400);
    assert.equal((await post({ ...valid, model: 'unsupported', settings: { provider: 'codex-app-server' } })).status, 400, 'Client model validation must remain a 400 even for Codex.');
    assert.equal(captured.length, 0, 'Invalid requests must not contact a model.');

    const response = await post({ ...valid, sourcePageNumber: 999, imageDataUrl: 'data:image/png;base64,forged-client-image' });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.pageNumber, 3);
    assert.equal(result.sourcePageNumber, 5, 'Original page mapping must come from the bound source, never the client.');
    assert.equal(result.model, 'gpt-6-astra');
    assert.equal(result.usage.totalTokens, 200);
    assert.equal(captured[0].store, false);
    assert.equal(captured[0].text.format.strict, true);
    const expectedImage = await sharp(Buffer.from(sourceSvg), { density: 180 }).resize({ width: 1800, height: 2400, fit: 'inside' }).png().toBuffer();
    assert.equal(captured[0].input[0].content[0].image_url, `data:image/png;base64,${expectedImage.toString('base64')}`, 'Only the server-owned source page image may be sent.');
    assert.equal(await (await fetch(pageUrl)).text(), sourceSvg, 'OCR must not alter the source preview.');

    const upload = async (bytes, fileName) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
      const response = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const selectedPdf = await readFile(join(root, 'public/demos/openai-paper-selected.pdf'));
    const callCountBeforeUploads = captured.length;
    const uploaded = await upload(selectedPdf, 'openai-paper-selected.pdf');
    assert.equal(uploaded.demo, false, 'A real upload remains a new user document.');
    assert.notEqual(uploaded.documentId, demo.document.documentId);
    assert.equal(uploaded.sourceHash, demo.paper.selectedSha256);
    assert.deepEqual(uploaded.paperSource.sourcePages, [1, 2, 5]);
    assert.equal(uploaded.pageCount, 3);
    for (const field of ['blocks', 'annotations', 'provenance', 'ocrResults']) assert.equal(field in uploaded, false, `Upload response must not contain cached ${field}.`);
    assert.ok(uploaded.pages.every((page) => !('blocks' in page) && !('extractedText' in page)), 'Upload page entries describe previews, not prior OCR results.');
    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const svg = await (await fetch(`${baseUrl}/api/documents/${uploaded.documentId}/pages/${pageNumber}.svg`)).text();
      const image = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
      assert.ok(image, 'A byte-identical uploaded source must retain math-safe raster previews.');
      assert.equal(digest(Buffer.from(image[1], 'base64')), demo.provenance.imageSha256[pageNumber - 1]);
    }
    const renamed = await upload(selectedPdf, 'renamed-research-copy.pdf');
    assert.equal(renamed.demo, false);
    assert.equal(renamed.sourceHash, uploaded.sourceHash);
    assert.deepEqual(renamed.paperSource.sourcePages, [1, 2, 5], 'The same bytes retain their original page mapping regardless of filename.');
    assert.notEqual(renamed.documentId, uploaded.documentId);

    const unrelatedPdf = await PDFDocument.create();
    const font = await unrelatedPdf.embedFont(StandardFonts.Helvetica);
    unrelatedPdf.addPage([612, 792]).drawText('Independent uploaded document', { x: 60, y: 700, size: 20, font });
    const unrelated = await upload(Buffer.from(await unrelatedPdf.save()), 'openai-paper-selected.pdf');
    assert.equal(unrelated.demo, false);
    assert.equal(unrelated.pageCount, 1);
    assert.notEqual(unrelated.sourceHash, uploaded.sourceHash);
    assert.equal('paperSource' in unrelated, false, 'A different PDF with the selected filename must never inherit paper metadata.');
    const unrelatedSvg = await (await fetch(`${baseUrl}/api/documents/${unrelated.documentId}/pages/1.svg`)).text();
    assert.match(unrelatedSvg, /Independent uploaded document/);
    assert.notEqual(unrelatedSvg, sourceSvg, 'A mismatched source must use its own conversion, not the prepared paper preview.');
    assert.equal(captured.length, callCountBeforeUploads, 'Uploading and preparing previews must not invoke an OCR model.');

    const uploadedOcrResponse = await post({ ...valid, documentId: uploaded.documentId, sourcePageNumber: 999 });
    assert.equal(uploadedOcrResponse.status, 200, await uploadedOcrResponse.clone().text());
    const uploadedOcr = await uploadedOcrResponse.json();
    assert.equal(captured.length, callCountBeforeUploads + 1, 'Uploaded-paper OCR must make a new SDK request.');
    assert.equal(uploadedOcr.sourcePageNumber, 5, 'Uploaded copies derive original page numbering from the source hash.');
    assert.equal(uploadedOcr.blocks.length, 1);
    assert.equal(uploadedOcr.blocks[0].extractedText, 'Loopback test result', 'A rerun must return the provider response, never the stored real-demo transcription.');
    assert.equal(captured.at(-1).input[0].content[0].image_url, `data:image/png;base64,${expectedImage.toString('base64')}`);

    const unrelatedOcrResponse = await post({ ...valid, documentId: unrelated.documentId, pageNumber: 1, sourcePageNumber: 5 });
    assert.equal(unrelatedOcrResponse.status, 200);
    assert.equal((await unrelatedOcrResponse.json()).sourcePageNumber, 1, 'Unrelated uploads cannot claim the research-paper page map.');

    mode = 'hold';
    const held = post({ ...valid, pageNumber: 2 });
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(release, 'The fixture should receive the active OCR request.');
    assert.equal((await post({ ...valid, pageNumber: 2 })).status, 409, 'Concurrent OCR for the same page should be rejected.');
    release();
    assert.equal((await held).status, 200);
    mode = 'incomplete';
    assert.equal((await post(valid)).status, 500, 'Incomplete provider output must not be applied as OCR.');
    mode = 'complete';
    assert.equal((await post(valid)).status, 200, 'Provider failure must release the document lock for retry.');
  } finally {
    release?.();
    await stopApi(api);
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('intent HTTP SSE exposes actual model blocks before completion and releases failed stream locks', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intent-http-stream-test-'));
  const releaseFinal = deferred();
  const receivedFirstBlock = deferred();
  const captured = [];
  const provisional = { type: 'table', label: 'PERFORMANCE', note: 'Inspect this table.', bbox: { x: 0.5, y: 0.1, width: 0.4, height: 0.2 }, extractedText: 'Fixture table cells', latex: null, uncertain: false, uncertaintyReason: '' };
  const canonical = { ...provisional, note: 'Authoritative final note.' };
  let mode = 'gated';
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    captured.push(JSON.parse(raw));
    const activeMode = mode;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sequence = 0;
    const send = (event) => response.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
    const base = { id: 'resp_http_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'in_progress', output: [] };
    const message = { id: 'msg_http_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    send({ type: 'response.created', response: base });
    send({ type: 'response.output_item.added', output_index: 0, item: message });
    send({ type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    const delta = (text) => send({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] });
    delta(`{"blocks":[${JSON.stringify(provisional)}`);
    if (activeMode === 'gated') await releaseFinal.promise;
    delta('],"warnings":[]}');
    const finalText = JSON.stringify({ blocks: [canonical], warnings: [] });
    const finalMessage = { ...message, status: 'completed', content: [{ type: 'output_text', text: finalText, annotations: [] }] };
    send({ type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text: finalText, logprobs: [] });
    send({ type: 'response.output_item.done', output_index: 0, item: finalMessage });
    send({ type: activeMode === 'incomplete' ? 'response.incomplete' : 'response.completed', response: { ...base, status: activeMode === 'incomplete' ? 'incomplete' : 'completed', output: [finalMessage], usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } } } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  let api;
  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    api = startApi(port, join(directory, 'state'));
    await waitForApi(baseUrl, api);
    const demo = await (await fetch(`${baseUrl}/api/demo/paper-ocr`)).json();
    const body = { documentId: demo.document.documentId, pageNumber: 3, sourcePageNumber: 999, instruction: 'Label only the table as PERFORMANCE.', labelRules: [{ name: 'PERFORMANCE', description: 'A table reporting model measurements.' }], model: 'gpt-6-astra', settings: { provider: 'openai-compatible', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-only', reasoningEffort: 'low' } };
    const post = (value) => fetch(`${baseUrl}/api/ai/intent-stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    for (const malformed of [null, [], {}, { ...body, pageNumber: 0 }, { ...body, pageNumber: 4 }, { ...body, instruction: '' }, { ...body, labelRules: [{ name: '', description: '' }] }, { ...body, model: 'unsupported', settings: { provider: 'codex-app-server' } }]) {
      const result = await post(malformed);
      assert.equal(result.status, 400);
      assert.match(result.headers.get('content-type'), /application\/json/, 'Input failures happen before SSE headers.');
    }
    assert.equal(captured.length, 0);
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const early = [];
    let ended = false;
    const collection = collectSse(response, (event) => { early.push(event); if (event.event === 'block') receivedFirstBlock.resolve(); }).finally(() => { ended = true; });
    await bounded(receivedFirstBlock.promise);
    assert.ok(early.some((event) => event.event === 'start'));
    assert.ok(early.some((event) => event.event === 'activity'));
    assert.equal(early.some((event) => event.event === 'complete'), false);
    assert.equal(ended, false, 'HTTP annotations must be visible while the upstream final response remains held.');
    const first = early.find((event) => event.event === 'block');
    assert.equal(first.data.pageNumber, 3);
    assert.equal(first.data.block.label, 'PERFORMANCE');
    assert.equal(first.data.block.note, provisional.note);
    assert.equal(early.find((event) => event.event === 'start').data.sourcePageNumber, 5);
    assert.equal((await post(body)).status, 409, 'Active SSE requests retain the per-document lock.');
    releaseFinal.resolve();
    const events = await bounded(collection);
    const complete = events.find((event) => event.event === 'complete');
    assert.ok(complete);
    assert.equal(events.some((event) => event.event === 'error'), false);
    assert.equal(complete.data.model, 'gpt-6-astra');
    assert.equal(complete.data.sourcePageNumber, 5);
    assert.equal(complete.data.pageNumber, 3);
    assert.equal(complete.data.usage.totalTokens, 300);
    assert.deepEqual(complete.data.blocks, [{ ...canonical, id: 'intent-p3-b1' }]);
    assert.equal(captured[0].stream, true);
    assert.equal(captured[0].store, false);
    assert.match(captured[0].instructions, /Label only the table as PERFORMANCE/);
    assert.deepEqual(captured[0].text.format.schema.properties.blocks.items.properties.label.enum, ['PERFORMANCE']);
    assert.match(captured[0].instructions, /A table reporting model measurements/);

    mode = 'incomplete';
    const failureResponse = await post(body);
    assert.equal(failureResponse.status, 200, 'Provider failure after headers must be an SSE error.');
    const failureEvents = await bounded(collectSse(failureResponse));
    assert.equal(failureEvents.some((event) => event.event === 'complete'), false);
    assert.match(failureEvents.find((event) => event.event === 'error').data.error, /did not complete/);
    mode = 'complete';
    const retry = await post(body);
    assert.equal(retry.status, 200, 'Failed streams must release the document lock.');
    assert.ok((await bounded(collectSse(retry))).some((event) => event.event === 'complete'));
  } finally {
    releaseFinal.resolve();
    await stopApi(api); provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('intent API allows three distinct pages simultaneously and releases an aborted page for a fourth worker', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intent-parallel-api-'));
  const gates = new Map([1, 2, 3, 4].map((page) => [page, deferred()]));
  const cancelled = deferred();
  const received = [];
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    const page = Number(/Annotate page (\d+)/.exec(body.instructions)?.[1]);
    received.push(page);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: `resp_parallel_${page}`, object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'in_progress', output: [] };
    response.write(`data: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: base })}\n\n`);
    response.once('close', () => { if (page === 1) cancelled.resolve(); gates.get(page)?.resolve(); });
    await gates.get(page).promise;
    if (response.destroyed) return;
    const outputText = JSON.stringify({ blocks: [{ type: 'region', label: `PAGE ${page}`, note: 'Parallel fixture result.', bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, extractedText: `Page ${page}`, latex: null, uncertain: false, uncertaintyReason: '' }], warnings: [] });
    const result = { ...base, status: 'completed', output: [{ id: `msg_${page}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outputText, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.end(`data: ${JSON.stringify({ type: 'response.completed', sequence_number: 1, response: result })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  let api;
  const responses = [];
  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    api = startApi(port, join(directory, 'state'));
    await waitForApi(baseUrl, api);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const page of [1, 2, 3, 4]) pdf.addPage([612, 792]).drawText(`Page ${page}`, { x: 60, y: 700, size: 24, font });
    const form = new FormData();
    form.append('file', new Blob([await pdf.save()], { type: 'application/pdf' }), 'parallel-pages.pdf');
    const uploaded = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    const document = await uploaded.json();
    const post = (pageNumber) => fetch(`${baseUrl}/api/ai/intent-stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.documentId, pageNumber, instruction: `Annotate page ${pageNumber}.`, labelRules: [], model: 'gpt-6-astra', settings: { provider: 'openai-compatible', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-only', reasoningEffort: 'low' } }),
    });
    responses.push(...await Promise.all([1, 2, 3].map(post)));
    assert.ok(responses.every((response) => response.status === 200), 'Three independent pages must start simultaneously.');
    const receivedDeadline = Date.now() + 5000;
    while (received.length < 3 && Date.now() < receivedDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...received].sort(), [1, 2, 3]);
    const duplicate = await post(2);
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /page is already/);
    const fourth = await post(4);
    assert.equal(fourth.status, 409);
    assert.match((await fourth.json()).error, /Up to 3 pages/);
    assert.equal(received.length, 3, 'Rejected work must not reach the provider.');
    await responses[0].body.cancel();
    await bounded(cancelled.promise);
    let replacement;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      replacement = await post(4);
      if (replacement.status !== 409) break;
      await replacement.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(replacement.status, 200, 'Aborting a page must free a slot for a different page.');
    responses.push(replacement);
    for (const page of [2, 3, 4]) gates.get(page).resolve();
    const results = await Promise.all(responses.slice(1).map((response) => bounded(collectSse(response))));
    assert.deepEqual(results.map((events) => events.find((event) => event.event === 'complete').data.pageNumber), [2, 3, 4]);
    assert.deepEqual([...received].sort(), [1, 2, 3, 4]);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await stopApi(api); provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
