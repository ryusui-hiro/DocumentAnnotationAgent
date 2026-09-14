import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ExcelJS from 'exceljs';

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
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
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

function readSseEvents(text) {
  return text.split(/\r?\n\r?\n/u).flatMap((frame) => {
    const lines = frame.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return event && data ? [{ event, payload: JSON.parse(data) }] : [];
  });
}

async function readAgentResult(response, context) {
  const text = await response.text();
  assert.equal(response.status, 200, `${context} failed (${response.status}): ${text.slice(0, 1200)}`);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u, `${context} did not return SSE`);
  const events = readSseEvents(text);
  const error = events.find((item) => item.event === 'error');
  assert.equal(error, undefined, `${context} emitted an error: ${JSON.stringify(error?.payload)}`);
  const result = events.find((item) => item.event === 'result')?.payload;
  assert.ok(result, `${context} omitted its result event: ${text.slice(0, 1200)}`);
  assert.ok(events.some((item) => item.event === 'done'), `${context} omitted its done event`);
  return { result, events };
}

function functionCall(name, args, callId) {
  return { id: `fc-${callId}`, type: 'function_call', status: 'completed', call_id: callId, name, arguments: JSON.stringify(args) };
}

function responsesPayload(id, output, model = 'gpt-6-astra') {
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output,
    usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
  };
}

test('the process API runs the Agents SDK workbook tools, pauses for two approvals, and exports a readable XLSX copy', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-agent-xlsx-export-'));
  const providerRequests = [];
  const providerErrors = [];
  const scriptedTurns = [
    functionCall('get_workbook_outline', {}, 'xlsx-outline'),
    functionCall('inspect_sheet', { sheetName: 'Customers' }, 'xlsx-inspect-customers'),
    functionCall('read_range', { sheetName: 'Customers', range: 'A1:C4' }, 'xlsx-read-customer-table'),
    functionCall('create_column', {
      sheetName: 'Customers', header: 'Churn Risk', headerRow: 2,
      reason: 'Add the requested classification beside the actual customer header row.', reviewPriority: 'medium', requiresReview: true,
    }, 'xlsx-create-column'),
    functionCall('write_range', {
      sheetName: 'Customers', startAddress: 'D3', values: [['HIGH'], ['LOW']],
      reason: 'Aki is inactive while Mika has recent activity.', confidence: 0.94, reviewPriority: 'medium', requiresReview: true,
    }, 'xlsx-classify-customers'),
    functionCall('read_range', { sheetName: 'Customers', range: 'D2:D4' }, 'xlsx-verify-result'),
    functionCall('export_annotations', { format: 'native-annotated' }, 'xlsx-native-export'),
    { id: 'message-xlsx-finished', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The approved customer classifications are saved in the annotated workbook.', annotations: [] }] },
  ];
  let scriptedTurnIndex = 0;
  const provider = createServer(async (request, response) => {
    try {
      let bodyText = '';
      for await (const chunk of request) bodyText += chunk;
      const body = JSON.parse(bodyText);
      providerRequests.push({ url: request.url, authorization: request.headers.authorization, body });
      const output = scriptedTurns[scriptedTurnIndex++];
      if (!output) throw new Error(`Unexpected extra Responses request ${scriptedTurnIndex}: ${request.url}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responsesPayload(`response-xlsx-${scriptedTurnIndex}`, [output])));
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fake Responses API failed' }));
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
    assert.equal(health.aiConfigured, false, 'the API process must not have real provider credentials');

    const original = new ExcelJS.Workbook();
    original.creator = 'Annotation Studio acceptance fixture';
    const customers = original.addWorksheet('Customers');
    customers.mergeCells('A1:C1');
    customers.getCell('A1').value = 'Customer retention review';
    customers.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF20364A' } };
    customers.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBF7' } };
    customers.getRow(2).values = ['Customer', 'Plan', 'Last Login'];
    for (const address of ['A2', 'B2', 'C2']) {
      customers.getCell(address).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      customers.getCell(address).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315A7D' } };
    }
    customers.getRow(3).values = ['Aki', 'Pro', '2024-02-03'];
    customers.getRow(4).values = ['Mika', 'Basic', '2025-09-10'];
    customers.getColumn(1).width = 18;
    customers.getColumn(2).width = 14;
    customers.getColumn(3).width = 18;
    customers.getRow(3).height = 22;

    const notes = original.addWorksheet('Notes');
    notes.getCell('A1').value = 'Original workbook notes';
    notes.getCell('A1').font = { italic: true, color: { argb: 'FF5A6470' } };
    notes.getCell('B2').value = 'Leave this sheet untouched';
    notes.getCell('B2').alignment = { wrapText: true, vertical: 'middle' };
    notes.getRow(2).height = 28;
    const source = Buffer.from(await original.xlsx.writeBuffer());
    const originalSourceCopy = Buffer.from(source);
    const originalSourceHash = createHash('sha256').update(source).digest('hex');

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers.xlsx');
    const upload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: uploadForm, signal: AbortSignal.timeout(30_000) });
    const uploadText = await upload.text();
    assert.equal(upload.status, 200, `XLSX upload failed: ${uploadText.slice(0, 1000)}`);
    const document = JSON.parse(uploadText);
    assert.equal(document.fileName, 'customers.xlsx');
    assert.equal(document.sourceHash, originalSourceHash, 'the API must bind the upload to the exact original XLSX bytes');

    const settings = { provider: 'openai-compatible', endpoint: providerUrl, apiKey: 'agent-xlsx-acceptance-key', reasoningEffort: 'medium' };
    const runResponse = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        instruction: 'Inspect the customer table, create a Churn Risk column, classify each row, and export the completed annotated XLSX workbook.',
        taskPlan: '', guidelines: 'Use the actual table header row and the last-login evidence.', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'current',
        pageText: '', imageDataUrl: 'data:image/png;base64,AA==', model: 'gpt-6-astra', pageNumber: 1, totalPages: 1,
        agentMode: 'assist', requireToolApproval: true, existingAnnotations: [], documentAnnotations: [], settings, stream: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const first = await readAgentResult(runResponse, 'Initial XLSX Agent run');
    assert.equal(first.result.status, 'interrupted', 'Assist must pause before creating the column');
    assert.ok(first.result.approvalRunId && first.result.approvalId, 'the first review must expose the resumable Agent Run and tool call');
    assert.equal(first.result.approvalId, 'xlsx-create-column');
    assert.deepEqual(first.result.spreadsheetChanges.map((change) => [change.operation, change.range, change.requiresReview]), [['create_column', 'D2', true]]);
    const firstToolNames = first.events.filter((event) => event.event === 'activity').map((event) => event.payload.toolName);
    assert.deepEqual(firstToolNames, ['get_workbook_outline', 'inspect_sheet', 'read_range', 'create_column']);
    assert.equal(scriptedTurnIndex, 4);

    const downloadBeforeApproval = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook/export`);
    assert.equal(downloadBeforeApproval.status, 200);
    const unapprovedWorkbook = new ExcelJS.Workbook();
    await unapprovedWorkbook.xlsx.load(Buffer.from(await downloadBeforeApproval.arrayBuffer()));
    assert.equal(unapprovedWorkbook.getWorksheet('Customers')?.getCell('D2').value, null, 'a pending create_column call must not mutate the workbook');

    const resume = async (approvalId, approved, sourceHash = document.sourceHash) => fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ runId: first.result.approvalRunId, approvalId, approved, sourceHash, settings, stream: true }),
      signal: AbortSignal.timeout(60_000),
    });
    const staleApproval = await resume(first.result.approvalId, true, 'f'.repeat(64));
    assert.equal(staleApproval.status, 409, 'the approval endpoint must reject a decision for a different source hash');

    const createColumnResume = await readAgentResult(await resume(first.result.approvalId, true), 'Create-column approval and Agent resume');
    assert.equal(createColumnResume.result.status, 'interrupted', 'the same Agent Run should continue and pause for the classification values');
    assert.equal(createColumnResume.result.approvalRunId, first.result.approvalRunId, 'the same RunState must survive both approval cycles');
    assert.equal(createColumnResume.result.approvalId, 'xlsx-classify-customers');
    assert.deepEqual(createColumnResume.result.spreadsheetChanges.map((change) => [change.operation, change.range, change.requiresReview]), [
      ['create_column', 'D2', false], ['write_range', 'D3:D4', true],
    ]);
    assert.ok(createColumnResume.events.some((event) => event.event === 'activity' && event.payload.toolName === 'write_range'));
    const classificationChange = createColumnResume.result.spreadsheetChanges.find((change) => change.id === 'xlsx-classify-customers');
    assert.ok(classificationChange, 'the pending classification range was not returned for human review');

    const headerOnlyResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook/export`);
    const headerOnlyWorkbook = new ExcelJS.Workbook();
    await headerOnlyWorkbook.xlsx.load(Buffer.from(await headerOnlyResponse.arrayBuffer()));
    assert.equal(headerOnlyWorkbook.getWorksheet('Customers')?.getCell('D2').value, 'Churn Risk');
    assert.equal(headerOnlyWorkbook.getWorksheet('Customers')?.getCell('D3').value, null, 'approving the header alone must not apply pending classifications');

    const finalResumeResponse = await fetch(`${apiUrl}/api/ai/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ runId: first.result.approvalRunId, approvalId: createColumnResume.result.approvalId, approved: true, sourceHash: document.sourceHash, settings, stream: true }),
      signal: AbortSignal.timeout(60_000),
    });
    const finalResume = await readAgentResult(finalResumeResponse, 'Classification approval and final Agent resume');
    assert.equal(finalResume.result.status, 'complete');
    assert.equal(finalResume.result.approvalRunId, undefined);
    const finalToolNames = finalResume.events.filter((event) => event.event === 'activity').map((event) => event.payload.toolName);
    assert.ok(finalToolNames.includes('read_range'), `resumed Agent did not verify its cell values: ${finalToolNames.join(', ')}`);
    assert.ok(finalToolNames.includes('export_annotations'), `resumed Agent did not invoke native export: ${finalToolNames.join(', ')}`);
    assert.equal(finalResume.result.exports.length, 1, 'the Agent should prepare one downloadable native workbook');
    const artifact = finalResume.result.exports[0];
    assert.equal(artifact.format, 'native-annotated');
    assert.equal(artifact.fileName, 'customers-annotated.xlsx');
    assert.equal(artifact.annotationsExported, 2, 'both approved workbook changes should be represented in the native export');
    assert.equal(scriptedTurnIndex, scriptedTurns.length);
    assert.deepEqual(providerErrors, []);
    assert.ok(providerRequests.every((request) => request.url === '/v1/responses' && request.authorization === 'Bearer agent-xlsx-acceptance-key'));
    assert.ok(providerRequests.every((request) => request.body.store === false), 'Responses API requests must be memory-only');

    const download = await fetch(`${apiUrl}/api/document-exports/${encodeURIComponent(artifact.id)}`);
    assert.equal(download.status, 200, 'prepared XLSX artifact download failed');
    assert.match(download.headers.get('content-type') ?? '', /spreadsheetml\.sheet/u);
    assert.match(download.headers.get('content-disposition') ?? '', /customers-annotated\.xlsx/u);
    const exportedBytes = Buffer.from(await download.arrayBuffer());
    assert.ok(exportedBytes.byteLength > 0);

    const exportedWorkbook = new ExcelJS.Workbook();
    await exportedWorkbook.xlsx.load(exportedBytes);
    const exportedCustomers = exportedWorkbook.getWorksheet('Customers');
    assert.ok(exportedCustomers);
    assert.equal(exportedCustomers.getCell('D2').value, 'Churn Risk');
    assert.equal(exportedCustomers.getCell('D3').value, 'HIGH');
    assert.equal(exportedCustomers.getCell('D4').value, 'LOW');
    assert.deepEqual(['A2', 'B2', 'C2'].map((address) => exportedCustomers.getCell(address).value), ['Customer', 'Plan', 'Last Login']);
    assert.deepEqual(['A3:C4'].flatMap((range) => exportedCustomers.getCell(range.split(':')[0]).worksheet.getRows(3, 2).flatMap((row) => row.values.slice(1, 4))), ['Aki', 'Pro', '2024-02-03', 'Mika', 'Basic', '2025-09-10']);
    assert.equal(exportedCustomers.getCell('A2').font.bold, true, 'existing customer-header formatting should survive the new export');
    assert.equal(exportedCustomers.getCell('A2').fill.fgColor?.argb, 'FF315A7D');
    assert.equal(exportedCustomers.getCell('A1').value, 'Customer retention review');
    assert.equal(exportedCustomers.getCell('A1').font.bold, true);
    assert.deepEqual(exportedCustomers.getCell('A1').fill.fgColor?.argb, 'FFDCEBF7');

    const exportedNotes = exportedWorkbook.getWorksheet('Notes');
    assert.ok(exportedNotes, 'unrelated worksheet was removed from the workbook');
    assert.equal(exportedNotes.getCell('A1').value, 'Original workbook notes');
    assert.equal(exportedNotes.getCell('A1').font.italic, true);
    assert.equal(exportedNotes.getCell('B2').value, 'Leave this sheet untouched');
    assert.equal(exportedNotes.getCell('B2').alignment.wrapText, true);

    const sourceContextResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook/changes/${encodeURIComponent(classificationChange.id)}/context`);
    const sourceContextText = await sourceContextResponse.text();
    assert.equal(sourceContextResponse.status, 200, `original workbook context lookup failed: ${sourceContextText}`);
    const sourceContext = JSON.parse(sourceContextText);
    const originalCells = new Map(sourceContext.rows.flat().map((cell) => [cell.address, cell.value]));
    assert.equal(originalCells.get('B3'), 'Pro');
    assert.equal(originalCells.get('D3'), null, 'read-only source context must still show the original blank classification cell');
    assert.equal(originalCells.get('D4'), null, 'read-only source context must still show the original blank classification cell');
    assert.equal(createHash('sha256').update(source).digest('hex'), originalSourceHash, "Agent execution or export must not mutate the caller's source bytes");
    assert.deepEqual(source, originalSourceCopy);
  } finally {
    await stopApi(api);
    if (providerListening) {
      await new Promise((resolveClose) => { provider.close(() => resolveClose()); provider.closeAllConnections(); });
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
