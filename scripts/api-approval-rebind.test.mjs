import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
      HOST: '127.0.0.1',
      PORT: String(port),
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '',
      AZURE_OPENAI_ENDPOINT: '',
      AZURE_OPENAI_DEPLOYMENT_GPT6: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '',
      CODEX_APP_SERVER_DISABLED: 'true',
      ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-6000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-6000); });
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
  if (api.child.exitCode !== null || api.child.signalCode !== null) return;
  api.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => api.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
}

test('the approval API restores the same RunState with current compatible-API credentials', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-approval-rebind-'));
  const authorizationHeaders = [];
  const toolSequence = [
    { name: 'open_document', arguments: {} },
    { name: 'get_document_info', arguments: {} },
    { name: 'get_document_outline', arguments: {} },
    { name: 'inspect_page', arguments: {} },
    { name: 'request_review', arguments: {
      x: 0.2, y: 0.2, width: 0.3, height: 0.1,
      label: 'HIGH RISK', note: 'Review this clause.', reason: 'This is a risky termination clause.',
      excerpt: 'Either party may terminate without cause.', confidence: null, reviewPriority: 'high', requiresReview: true,
    } },
    { name: 'assistant', arguments: {} },
  ];
  let modelRequestIndex = 0;
  let signalReplacementRequest;
  const replacementRequest = new Promise((resolveReplacementRequest) => { signalReplacementRequest = resolveReplacementRequest; });
  const mockProvider = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.ok(body.length > 0);
      authorizationHeaders.push(request.headers.authorization ?? '');
      if (request.headers.authorization === 'Bearer replacement-test-key') {
        signalReplacementRequest();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      const scripted = toolSequence[modelRequestIndex++];
      if (!scripted) throw new Error('Unexpected model request.');
      const output = scripted.name === 'assistant'
        ? [{ id: `msg-${modelRequestIndex}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The human-reviewed clause is complete.', annotations: [] }] }]
        : [{ id: `fc-${modelRequestIndex}`, type: 'function_call', status: 'completed', call_id: `call-${scripted.name}`, name: scripted.name, arguments: JSON.stringify(scripted.arguments) }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: `resp-${modelRequestIndex}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model: 'gpt-6-astra', output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'mock provider failed' }));
    }
  });
  let api;
  let mockProviderListening = false;
  try {
    await new Promise((resolveListen, reject) => {
      mockProvider.once('error', reject);
      mockProvider.listen(0, '127.0.0.1', resolveListen);
    });
    mockProviderListening = true;
    const providerAddress = mockProvider.address();
    assert.ok(providerAddress && typeof providerAddress === 'object');
    const providerUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
    const apiPort = await availablePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    api = startApiServer(apiPort, dataDirectory);
    await waitForApi(apiUrl, api);
    const source = await readFile(resolve(root, 'public/demo-specification.pdf'));
    const upload = new FormData();
    upload.append('file', new Blob([source], { type: 'application/pdf' }), 'demo-specification.pdf');
    const uploaded = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: upload });
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 200, `PDF upload failed: ${uploadedText}`);
    const document = JSON.parse(uploadedText);

    const providerSettings = (apiKey) => ({ provider: 'openai-compatible', endpoint: providerUrl, apiKey, reasoningEffort: 'medium' });
    const analysis = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: 'Find the termination clause and ask for human review.',
        taskPlan: '', guidelines: '', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'current',
        pageText: 'Either party may terminate without cause.',
        imageDataUrl: 'data:image/png;base64,AA==',
        model: 'gpt-6-astra', pageNumber: 1, totalPages: document.pageCount,
        agentMode: 'assist', requireToolApproval: true,
        settings: providerSettings('original-test-key'),
      }),
    });
    const analysisText = await analysis.text();
    assert.equal(analysis.status, 200, `initial Agent request failed: ${analysisText}`);
    const paused = JSON.parse(analysisText);
    assert.equal(paused.status, 'interrupted');
    assert.ok(paused.approvalRunId && paused.approvalId);
    assert.equal(paused.model, 'gpt-6-astra');
    assert.ok(authorizationHeaders.length >= 5);
    assert.ok(authorizationHeaders.every((header) => header === 'Bearer original-test-key'));

    await stopApi(api);
    api = startApiServer(apiPort, dataDirectory);
    await waitForApi(apiUrl, api);

    const mismatchedSourceApproval = await fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: paused.approvalRunId,
        approvalId: paused.approvalId,
        approved: true,
        sourceHash: 'b'.repeat(64),
        settings: providerSettings('replacement-test-key'),
      }),
    });
    assert.equal(mismatchedSourceApproval.status, 409, 'the restored session must reject approvals from a different source hash');

    const approvalPromise = fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: paused.approvalRunId,
        approvalId: paused.approvalId,
        approved: true,
        sourceHash: document.sourceHash,
        settings: providerSettings('replacement-test-key'),
      }),
    });
    let replacementTimeout;
    try {
      await Promise.race([
        replacementRequest,
        new Promise((_, reject) => {
          replacementTimeout = setTimeout(() => reject(new Error('The resumed Run did not reach the replacement provider.')), 10_000);
          replacementTimeout.unref();
        }),
      ]);
    } finally { clearTimeout(replacementTimeout); }
    const overlappingApproval = await fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: paused.approvalRunId,
        approvalId: paused.approvalId,
        approved: true,
        sourceHash: document.sourceHash,
        settings: providerSettings('racing-test-key'),
      }),
    });
    assert.equal(overlappingApproval.status, 409, `a concurrent second approval must be rejected: ${await overlappingApproval.text()}`);

    const approval = await approvalPromise;
    const approvalText = await approval.text();
    assert.equal(approval.status, 200, `approval resume failed: ${approvalText}`);
    const resumed = JSON.parse(approvalText);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.model, 'gpt-6-astra');
    assert.equal(authorizationHeaders.at(-1), 'Bearer replacement-test-key');
    assert.equal(modelRequestIndex, toolSequence.length);
  } finally {
    if (api) await stopApi(api);
    if (mockProviderListening) await new Promise((resolveClose) => { mockProvider.close(() => resolveClose()); mockProvider.closeAllConnections(); });
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
