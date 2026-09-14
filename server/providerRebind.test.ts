import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import OpenAI from 'openai';
import { preview } from 'document-svg';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configurePendingAgentRunStoreForTests, getPendingAgentRunInfo, restorePendingAgentRun, resumeDocumentAgentRun, runDocumentAgent } from './documentAgent';
import { privateRecordStore, createPrivateRecordStore } from './privateRecordStore';
import { PagedDocumentAdapter } from './documentAdapter';

const modelResponses = [
  { tool: 'open_document', arguments: {} },
  { tool: 'get_document_info', arguments: {} },
  { tool: 'get_document_outline', arguments: {} },
  { tool: 'inspect_page', arguments: {} },
  { tool: 'request_review', arguments: {
    x: 0.2, y: 0.2, width: 0.3, height: 0.1,
    label: 'HIGH RISK', note: 'Review this clause.', reason: 'This is a risky termination clause.',
    excerpt: 'Either party may terminate without cause.', confidence: null, reviewPriority: 'high', requiresReview: true,
  } },
  { tool: 'final', arguments: null },
] as const;

async function respond(request: IncomingMessage, response: ServerResponse, index: number, authHeaders: string[]) {
  let body = '';
  for await (const chunk of request) body += chunk;
  authHeaders.push(request.headers.authorization ?? '');
  const scripted = modelResponses[index];
  if (!scripted) {
    response.writeHead(500).end(JSON.stringify({ error: 'Unexpected model request.' }));
    return;
  }
  const output = scripted.tool === 'final'
    ? [{ id: `msg-${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The reviewed clause was annotated.', annotations: [] }] }]
    : [{ id: `fc-${index}`, type: 'function_call', status: 'completed', call_id: `call-${scripted.tool}`, name: scripted.tool, arguments: JSON.stringify(scripted.arguments) }];
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    id: `resp-${index}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'gpt-6-astra', output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }));
}

test('the same interrupted RunState resumes with replacement credentials without persisting a key or its fingerprint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-provider-rebind-'));
  const store = createPrivateRecordStore(directory);
  const authHeaders: string[] = [];
  let modelRequestIndex = 0;
  const mockProvider = createServer((request, response) => {
    void respond(request, response, modelRequestIndex++, authHeaders);
  });
  await new Promise<void>((resolveListen, reject) => {
    mockProvider.once('error', reject);
    mockProvider.listen(0, '127.0.0.1', resolveListen);
  });
  const address = mockProvider.address();
  assert.ok(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  let approvalRunId = '';

  configurePendingAgentRunStoreForTests(store);
  try {
    const samplePath = resolve('public/demo-specification.pdf');
    const sourceBuffer = await readFile(samplePath);
    const report = await preview(samplePath);
    const documentAdapter = new PagedDocumentAdapter('demo-specification.pdf', report, 'provider-rebind-document', sourceBuffer);
    const firstClient = new OpenAI({ apiKey: 'original-test-key', baseURL });
    const paused = await runDocumentAgent({
      client: firstClient,
      model: 'gpt-6-astra',
      modelId: 'gpt-6-astra',
      providerName: 'openai-compatible',
      providerConfigFingerprint: 'original-live-config',
      reasoningEffort: 'medium',
      instruction: 'Find a termination clause and ask me to review it.',
      taskPlan: '', guidelines: '', correction: '', humanDecisions: '',
      pageText: 'Either party may terminate without cause.',
      imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: report.pageCount,
      mode: 'assist', documentId: documentAdapter.documentId, sourceHash: 'a'.repeat(64),
      documentAdapters: [documentAdapter], requireToolApproval: true,
    });
    assert.equal(paused.status, 'interrupted');
    assert.ok(paused.approvalRunId && paused.approvalId);
    approvalRunId = paused.approvalRunId;
    assert.equal(authHeaders.length, 5);
    assert.ok(authHeaders.every((header) => header === 'Bearer original-test-key'));
    assert.equal((await getPendingAgentRunInfo(approvalRunId))?.liveProviderConfigFingerprint, 'original-live-config');

    const storedRun = await store.get<Record<string, unknown>>('pending-agent-runs', approvalRunId);
    assert.ok(storedRun);
    const serializedRun = JSON.stringify(storedRun);
    assert.equal(serializedRun.includes('original-test-key'), false, 'the API key must not be written to the pending-run store');
    assert.equal(serializedRun.includes('original-live-config'), false, 'the credential fingerprint is in-memory only');

    const replacementClient = new OpenAI({ apiKey: 'replacement-test-key', baseURL });
    assert.equal(await restorePendingAgentRun({
      runId: approvalRunId,
      client: replacementClient,
      providerName: 'openai-compatible',
      providerConfigFingerprint: 'replacement-live-config',
      forceRestore: true,
      documentAdapters: [documentAdapter],
    }), true);
    assert.equal((await getPendingAgentRunInfo(approvalRunId))?.liveProviderConfigFingerprint, 'replacement-live-config');

    const resumed = await resumeDocumentAgentRun({ runId: approvalRunId, approvalId: paused.approvalId, approved: true });
    assert.equal(resumed.status, 'complete');
    assert.equal(authHeaders.length, 6);
    assert.equal(authHeaders.at(-1), 'Bearer replacement-test-key');
    assert.equal(modelRequestIndex, modelResponses.length);
  } finally {
    if (approvalRunId) await store.delete('pending-agent-runs', approvalRunId).catch(() => undefined);
    configurePendingAgentRunStoreForTests(privateRecordStore);
    await new Promise<void>((resolveClose) => mockProvider.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});
