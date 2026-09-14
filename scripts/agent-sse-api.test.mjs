import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { taskPlanAsInstructions } from '../src/taskPlan.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

async function availablePort() {
  const probe = createPortProbe();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function startApiServer(port, dataDirectory) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
      AZURE_OPENAI_DEPLOYMENT_GPT6: '', AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '', AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '',
      CODEX_APP_SERVER_DISABLED: 'true', ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-6_000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-6_000); });
  return { child, get output() { return output; } };
}

async function waitForApi(baseUrl, api, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`API exited before readiness (${api.child.exitCode}).\n${api.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`API did not become ready: ${lastError}.\n${api.output}`);
}

async function stopApi(api) {
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) return;
  api.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => api.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
}

function withTimeout(promise, message, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function pumpAgentSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  let signalScrollActivity;
  const scrollActivity = new Promise((resolve) => { signalScrollActivity = resolve; });
  const pump = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? '\n\n';
        buffer = buffer.slice(boundary + separator.length);
        const lines = frame.split(/\r?\n/u);
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) {
          const payload = JSON.parse(data);
          frames.push({ event, payload });
          if (event === 'activity' && payload.toolName === 'scroll_document') signalScrollActivity();
        }
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const lines = buffer.trim().split(/\r?\n/u);
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) frames.push({ event, payload: JSON.parse(data) });
    }
    return frames;
  })();
  return { frames, scrollActivity, pump };
}

test('the real Planner and Agents SDK API stream navigation, pause for review, resume, and export', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-agent-sse-'));
  const providerRequests = [];
  const providerErrors = [];
  const scriptedTurns = [
    { name: 'open_document', arguments: {} },
    { name: 'get_document_info', arguments: {} },
    { name: 'get_document_outline', arguments: {} },
    { name: 'inspect_page', arguments: {} },
    { name: 'validate_annotations', arguments: {} },
    { name: 'export_annotations', arguments: { format: 'annotations-json' } },
    { name: 'assistant', arguments: {} },
    { name: 'open_document', arguments: {} },
    { name: 'get_document_info', arguments: {} },
    { name: 'get_document_outline', arguments: {} },
    { name: 'inspect_page', arguments: {} },
    { name: 'validate_annotations', arguments: {} },
    { name: 'export_annotations', arguments: { format: 'annotations-json' } },
    { name: 'assistant', arguments: {} },
    { name: 'open_document', arguments: {} },
    { name: 'get_document_info', arguments: {} },
    { name: 'get_document_outline', arguments: {} },
    { name: 'search_document', arguments: { query: 'termination' } },
    { name: 'navigate_page', arguments: { pageNumber: 2, reason: 'Review the first page after the opening page.' } },
    { name: 'inspect_page', arguments: {} },
    { name: 'scroll_document', arguments: { direction: 'down', amount: 0.12 } },
    { name: 'inspect_page', arguments: {} },
    ...Array.from({ length: 11 }, (_, index) => {
      const pageNumber = index + 3;
      return [
        { name: 'navigate_page', arguments: { pageNumber, reason: `Review page ${pageNumber} in the full-document scope.` } },
        { name: 'inspect_page', arguments: {} },
      ];
    }).flat(),
    { name: 'navigate_page', arguments: { pageNumber: 14, reason: 'Search located the termination clause on page 14.' } },
    { name: 'inspect_page', arguments: {} },
    { name: 'request_review', arguments: {
      x: 0.2, y: 0.32, width: 0.5, height: 0.1,
      label: 'HIGH RISK', note: 'Unilateral termination without cause.',
      reason: 'The visible clause allows either party to terminate without a breach condition.',
      excerpt: 'Either party may terminate for convenience on thirty days written notice.',
      confidence: 0.9, reviewPriority: 'high', requiresReview: true,
    } },
    { name: 'navigate_page', arguments: { pageNumber: 15, reason: 'Continue checking the remaining document after review.' } },
    { name: 'inspect_page', arguments: {} },
    { name: 'annotate_region', arguments: {
      x: 0.18, y: 0.28, width: 0.42, height: 0.08,
      label: 'APPENDIX', note: 'The final page was inspected after review.',
      reason: 'This visible appendix title is a clear low-priority classification.',
      excerpt: 'APPENDIX. The document ends here.',
      confidence: 0.9, reviewPriority: 'low', requiresReview: false,
    } },
    { name: 'assistant', arguments: {} },
  ];
  let modelRequestIndex = 0;
  let releaseReviewResponse;
  const reviewResponseGate = new Promise((resolve) => { releaseReviewResponse = resolve; });
  let signalReviewResponseStarted;
  const reviewResponseStarted = new Promise((resolve) => { signalReviewResponseStarted = resolve; });
  const provider = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      providerRequests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
      if (providerRequests.at(-1).body.text?.format?.name === 'annotation_task_plan') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'response-task-plan', object: 'response', created_at: Math.floor(Date.now() / 1000),
          status: 'completed', model: 'gpt-6-astra',
          output: [{ id: 'message-task-plan', type: 'message', role: 'assistant', status: 'completed', content: [{
            type: 'output_text', text: JSON.stringify({
              title: 'Termination clause review',
              objective: 'Find and classify termination clauses.',
              labels: [{ name: 'HIGH RISK', description: 'Unilateral termination without a breach condition.' }],
              actions: ['Highlight the clause and cite visible evidence.'],
              uncertaintyPolicy: 'Ask a reviewer when the wording or conditions are unclear.',
              workflow: ['Read the document pages.', 'Inspect likely matches.', 'Classify each match with evidence.'],
            }), annotations: [],
          }] }],
          usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
        }));
        return;
      }
      const scripted = scriptedTurns[modelRequestIndex++];
      if (!scripted) throw new Error('Unexpected extra Responses request.');
      if (scripted.name === 'request_review') {
        signalReviewResponseStarted();
        await reviewResponseGate;
      }
      const output = scripted.name === 'assistant'
        ? [{ id: `message-${modelRequestIndex}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The page-14 clause was highlighted after visual review.', annotations: [] }] }]
        : [{ id: `function-${modelRequestIndex}`, type: 'function_call', status: 'completed', call_id: `call-${modelRequestIndex}`, name: scripted.name, arguments: JSON.stringify(scripted.arguments) }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: `response-${modelRequestIndex}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model: 'gpt-6-astra', output,
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      }));
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fake Responses server failed' }));
    }
  });

  let providerListening = false;
  let api;
  try {
    await new Promise((resolveListen, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolveListen);
    });
    providerListening = true;
    const providerAddress = provider.address();
    assert.ok(providerAddress && typeof providerAddress === 'object');
    const providerUrl = `http://127.0.0.1:${providerAddress.port}/v1`;

    const apiPort = await availablePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    api = startApiServer(apiPort, dataDirectory);
    await waitForApi(apiUrl, api);
    const health = await fetch(`${apiUrl}/api/health`).then((result) => result.json());
    assert.equal(health.aiConfigured, false, 'the API should have no real credentials or configured external provider');
    const providerSettings = { provider: 'openai-compatible', endpoint: providerUrl, apiKey: 'agent-sse-test-key', reasoningEffort: 'medium' };
    const planResponse = await fetch(`${apiUrl}/api/ai/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: 'Find the termination clause and classify its risk.',
        guidelines: 'Use HIGH RISK for unilateral termination without cause.',
        correction: '', mode: 'assist', model: 'gpt-6-astra', settings: providerSettings,
      }),
    });
    const planPayload = await planResponse.json();
    assert.equal(planResponse.status, 200, `the real Task Planner API failed: ${JSON.stringify(planPayload)}`);
    assert.equal(planPayload.source, 'model');
    assert.equal(planPayload.plan.title, 'Termination clause review');
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0].body.text?.format?.name, 'annotation_task_plan');
    assert.equal(providerRequests[0].body.store, false);

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText('INTRODUCTION. This fictional fifteen-page document starts here.', { x: 50, y: 700, size: 14, font });
    for (let pageNumber = 2; pageNumber <= 13; pageNumber += 1) {
      pdf.addPage([612, 792]).drawText(`GENERAL TERMS. Page ${pageNumber} has no termination clause.`, { x: 50, y: 700, size: 14, font });
    }
    pdf.addPage([612, 792]).drawText('TERMINATION. Either party may terminate for convenience on thirty days written notice.', { x: 50, y: 700, size: 14, font });
    pdf.addPage([612, 792]).drawText('APPENDIX. The document ends here.', { x: 50, y: 700, size: 14, font });
    const source = Buffer.from(await pdf.save());
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([source], { type: 'application/pdf' }), 'agent-sse-contract.pdf');
    const upload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: uploadForm });
    const uploadText = await upload.text();
    assert.equal(upload.status, 200, `the PDF upload failed: ${uploadText}`);
    const document = JSON.parse(uploadText);
    assert.equal(document.pageCount, 15);

    const forgedTask = 'Review all fifteen pages and export JSON.';
    const wrongPageCount = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: forgedTask, taskPlan: taskPlanAsInstructions(planPayload.plan), guidelines: '', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'all',
        pageText: 'INTRODUCTION. This fictional fifteen-page document starts here.', imageDataUrl: 'data:image/png;base64,AA==',
        model: 'gpt-6-astra', pageNumber: 1, totalPages: 1, agentMode: 'assist', alreadyInspectedPages: [1], settings: providerSettings,
      }),
    });
    assert.equal(wrongPageCount.status, 409, 'the server rejects a client page count that differs from the uploaded document');
    assert.match((await wrongPageCount.json()).error, /ページ数/u);
    assert.equal(providerRequests.length, 1, 'a forged page count is rejected before the annotation model is called');

    const forgedCheckpoint = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: forgedTask, taskPlan: taskPlanAsInstructions(planPayload.plan), guidelines: '', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'all',
        pageText: 'INTRODUCTION. This fictional fifteen-page document starts here.', imageDataUrl: 'data:image/png;base64,AA==',
        model: 'gpt-6-astra', pageNumber: 1, totalPages: 15, agentMode: 'assist',
        alreadyInspectedPages: Array.from({ length: 15 }, (_, index) => index + 1), settings: providerSettings,
      }),
    });
    assert.equal(forgedCheckpoint.status, 200);
    const forgedResult = await forgedCheckpoint.json();
    assert.equal(forgedResult.status, 'incomplete', 'client supplied inspected-page arrays cannot complete the full-document export gate');
    assert.deepEqual(forgedResult.inspectedPages, [1]);
    assert.deepEqual(forgedResult.remainingPages, Array.from({ length: 14 }, (_, index) => index + 2));
    assert.deepEqual(forgedResult.exports, []);
    assert.equal(forgedResult.toolEvents.some((event) => event.toolName === 'validate_annotations' && event.status === 'complete'), false);
    assert.equal(forgedResult.toolEvents.some((event) => event.toolName === 'export_annotations' && /ready for download/.test(event.detail)), false);

    await stopApi(api);
    api = startApiServer(apiPort, dataDirectory);
    await waitForApi(apiUrl, api);
    const forgedAfterRestart = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: forgedTask, taskPlan: taskPlanAsInstructions(planPayload.plan), guidelines: '', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'all',
        pageText: 'GENERAL TERMS. Page 2 has no termination clause.', imageDataUrl: 'data:image/png;base64,AA==',
        model: 'gpt-6-astra', pageNumber: 2, totalPages: 15, agentMode: 'assist',
        alreadyInspectedPages: Array.from({ length: 15 }, (_, index) => index + 1), settings: providerSettings,
      }),
    });
    assert.equal(forgedAfterRestart.status, 200);
    const resumedForgeryResult = await forgedAfterRestart.json();
    assert.equal(resumedForgeryResult.status, 'incomplete', 'restart-restored session still ignores a forged client checkpoint');
    assert.deepEqual(resumedForgeryResult.inspectedPages, [1, 2]);
    assert.deepEqual(resumedForgeryResult.remainingPages, Array.from({ length: 13 }, (_, index) => index + 3));
    assert.deepEqual(resumedForgeryResult.exports, []);

    const analysis = await withTimeout(fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        instruction: 'Find the termination clause across all fifteen pages. Navigate, inspect, scroll for detail, and highlight unilateral termination as HIGH RISK.',
        taskPlan: taskPlanAsInstructions(planPayload.plan),
        guidelines: 'Use page evidence. The page-14 clause permits termination without a breach condition.',
        correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'all', exportScope: 'all',
        pageText: 'INTRODUCTION. This fictional fifteen-page document starts here.',
        imageDataUrl: 'data:image/png;base64,AA==',
        model: 'gpt-6-astra', pageNumber: 1, totalPages: 15, agentMode: 'assist',
        requireToolApproval: true, existingAnnotations: [], documentAnnotations: [],
        settings: providerSettings,
        stream: true,
      }),
    }), 'the streaming Agent API did not return SSE headers', 12_000);
    if (analysis.status !== 200) throw new Error(`Agent API request failed (${analysis.status}): ${await analysis.text()}`);
    assert.match(analysis.headers.get('content-type') ?? '', /text\/event-stream/u);
    const stream = pumpAgentSse(analysis);
    const expectedEarlyEvents = Promise.all([stream.scrollActivity, reviewResponseStarted]);
    await withTimeout(Promise.race([
      expectedEarlyEvents,
      stream.pump.then(() => { throw new Error(`SSE ended before the review request with frames ${JSON.stringify(stream.frames.map((frame) => frame.event))}.`); }),
    ]), `the API did not stream tool activity before the final model response; providerRequests=${providerRequests.length}, providerErrors=${JSON.stringify(providerErrors)}, modelRequestIndex=${modelRequestIndex}`, 12_000);
    assert.ok(stream.frames.some((frame) => frame.event === 'activity' && frame.payload.toolName === 'navigate_page'));
    assert.ok(stream.frames.some((frame) => frame.event === 'activity' && frame.payload.toolName === 'scroll_document'));
    assert.equal(stream.frames.some((frame) => frame.event === 'result'), false, 'the response should remain open while the review request is held');

    releaseReviewResponse();
    const initialFrames = await withTimeout(stream.pump, 'the Agent SSE response did not finish after the review request');
    const initialEvents = initialFrames.map((frame) => frame.event);
    const initialActivityNames = initialFrames.filter((frame) => frame.event === 'activity').map((frame) => frame.payload.toolName);
    const initialResult = initialFrames.find((frame) => frame.event === 'result')?.payload;
    assert.equal(initialResult.status, 'interrupted');
    assert.ok(initialResult.approvalRunId && initialResult.approvalId);
    assert.equal(initialResult.blockedPage, 14);
    assert.ok(initialResult.visitedPages.includes(14), 'the paused Agent Run did not retain the page-14 review location');
    assert.equal(initialResult.visitedPages.length, 14, `the same Agent Run did not navigate through the first fourteen pages: ${JSON.stringify(initialResult.visitedPages)}`);
    assert.deepEqual(initialResult.inspectedPages, Array.from({ length: 14 }, (_, index) => index + 1), 'the interrupted result should expose its checked-page checkpoint');
    assert.deepEqual(initialResult.remainingPages, [15], 'the interrupted result should identify the exact uninspected page');
    const orderedTools = ['open_document', 'get_document_info', 'get_document_outline', 'search_document', 'navigate_page', 'inspect_page', 'scroll_document', 'inspect_page', 'request_review'];
    let previousIndex = -1;
    for (const toolName of orderedTools) {
      const index = initialActivityNames.indexOf(toolName, previousIndex + 1);
      assert.ok(index > previousIndex, `tool event ${toolName} was missing or out of order: ${initialActivityNames.join(' → ')}`);
      previousIndex = index;
    }
    const initialResultIndex = initialEvents.indexOf('result');
    assert.ok(initialResultIndex > initialEvents.lastIndexOf('activity'), 'the interruption result must follow streamed tool activity');
    assert.equal(initialEvents.at(-1), 'done');
    assert.equal(initialEvents.includes('error'), false);

    const approvalResponse = await withTimeout(fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        runId: initialResult.approvalRunId,
        approvalId: initialResult.approvalId,
        approved: true,
        sourceHash: document.sourceHash,
        settings: providerSettings,
        stream: true,
      }),
    }), 'the approval endpoint did not return the resumed SSE stream', 12_000);
    assert.equal(approvalResponse.status, 200);
    assert.match(approvalResponse.headers.get('content-type') ?? '', /text\/event-stream/u);
    const approvalStream = pumpAgentSse(approvalResponse);
    const resumedFrames = await withTimeout(approvalStream.pump, 'the approved RunState did not finish');
    const approvalEvents = resumedFrames.map((frame) => frame.event);
    const resumedActivityNames = resumedFrames.filter((frame) => frame.event === 'activity').map((frame) => frame.payload.toolName);
    const result = resumedFrames.find((frame) => frame.event === 'result')?.payload;
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.inspectedPages, Array.from({ length: 15 }, (_, index) => index + 1), 'the resumed result should return the cumulative inspection checkpoint');
    assert.deepEqual(result.remainingPages, [], 'a fully inspected RunState should expose no remaining pages');
    assert.ok(result.visitedPages.includes(15), `the resumed RunState did not continue to page 15: ${JSON.stringify(result.visitedPages)}`);
    assert.ok(resumedActivityNames.includes('navigate_page'));
    assert.ok(resumedActivityNames.includes('inspect_page'));
    assert.ok(resumedActivityNames.includes('annotate_region'));
    const continued = result.annotations.find((annotation) => annotation.label === 'APPENDIX');
    assert.ok(continued);
    assert.equal(continued.pageNumber, 15);
    assert.equal(approvalEvents.includes('done'), true);
    assert.equal(approvalEvents.includes('error'), false);
    assert.equal(providerRequests.length, scriptedTurns.length + 1);
    assert.ok(providerRequests.every((item) => item.url === '/v1/responses' && item.authorization === 'Bearer agent-sse-test-key'));
    assert.ok(providerRequests.every((item) => item.body.store === false), 'Planner and Agent Requests should stay memory-only');
    const exportedResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'annotations-json' }),
    });
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.json();
    assert.ok(exported.documentAnnotations.some((record) => record.label === 'HIGH RISK' && record.status === 'approved'));
    assert.ok(exported.documentAnnotations.some((record) => record.label === 'APPENDIX' && record.status === 'auto'));
  } finally {
    releaseReviewResponse();
    await stopApi(api);
    if (providerListening) await new Promise((resolveClose) => { provider.close(() => resolveClose()); provider.closeAllConnections(); });
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
