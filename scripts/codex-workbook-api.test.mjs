import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function startApiServer(port, dataDirectory, codexBinary, capturePath) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
      AZURE_OPENAI_DEPLOYMENT_GPT6: '', AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '', AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '',
      CODEX_APP_SERVER_DISABLED: 'false', CODEX_APP_SERVER_BIN: codexBinary,
      CODEX_APP_SERVER_CAPTURE: capturePath, ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
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
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) return;
  api.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => api.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
}

function readSseResult(text) {
  const frame = text.split(/\r?\n\r?\n/u).find((item) => item.split(/\r?\n/u).some((line) => line === 'event: result'));
  assert.ok(frame, 'Codex workbook stream omitted its final result event.');
  const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  return JSON.parse(data);
}

test('Codex connection test checks sign-in before its catalog and hides account details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-codex-auth-api-'));
  const binary = join(directory, 'fake-codex.cjs');
  const statePath = join(directory, 'auth.json');
  const callsPath = `${statePath}.requests`;
  let api;
  try {
    await writeFile(binary, `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CODEX_APP_SERVER_CAPTURE + '.requests', request.method + '\\n');
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'account/read') send({ id: request.id, result: JSON.parse(readFileSync(process.env.CODEX_APP_SERVER_CAPTURE, 'utf8')) });
  if (request.method === 'model/list') send({ id: request.id, result: { data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra' }], nextCursor: null } });
});
`, { mode: 0o755 });
    await writeFile(statePath, JSON.stringify({ account: null, requiresOpenaiAuth: true }));
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    api = startApiServer(port, join(directory, 'api-state'), binary, statePath);
    await waitForApi(baseUrl, api);
    const check = (model = 'gpt-6-astra') => fetch(`${baseUrl}/api/ai/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, settings: { provider: 'codex-app-server', reasoningEffort: 'low' } }),
    });

    const missing = await check();
    assert.equal(missing.status, 401);
    assert.match((await missing.json()).error, /codex login/);
    assert.doesNotMatch(await readFile(callsPath, 'utf8'), /model\/list/, 'An unsigned account must not be reported ready from its catalog.');

    await writeFile(statePath, JSON.stringify({ account: { type: 'chatgpt', email: 'synthetic-private@example.test', planType: 'pro' }, requiresOpenaiAuth: true }));
    const signedIn = await check();
    assert.equal(signedIn.status, 200);
    assert.deepEqual(await signedIn.json(), { ok: true, provider: 'codex-app-server', model: 'gpt-6-astra', reasoningEffort: 'low' });

    const unknownModel = await check('gpt-5.6-sol');
    assert.equal(unknownModel.status, 409, 'Authenticated accounts still require an available selected model.');

    await writeFile(statePath, JSON.stringify({ account: null, requiresOpenaiAuth: false }));
    const externalProvider = await check();
    assert.equal(externalProvider.status, 200, 'A provider explicitly requiring no OpenAI authentication remains usable.');
    assert.doesNotMatch(await readFile(callsPath, 'utf8'), /thread\/start|turn\/start/, 'Readiness checks must not start billable model generation.');
  } finally {
    await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex App Server reads bounded XLSX ranges, stages pending edits, and applies only source-bound approvals', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-codex-workbook-api-'));
  const dataDirectory = join(temporaryDirectory, 'api-state');
  const codexBinary = join(temporaryDirectory, 'fake-codex-app-server.js');
  const capturePath = join(temporaryDirectory, 'turns.jsonl');
  const proposals = [
    { phase: 'read_ranges', readRequests: [{ sheetName: 'Customers', range: 'A1:B3', purpose: 'Confirm the header row and inspect every customer example.' }], changes: [] },
    { phase: 'propose_changes', readRequests: [], changes: [
      { operation: 'create_column', sheetName: 'Customers', address: '', header: 'Churn Risk', headerRow: 1, values: [['HIGH'], ['LOW']], reason: 'The first customer has no recent login and the second has a recent login.', confidence: 0.9, reviewPriority: 'high', requiresReview: true },
      { operation: 'write_range', sheetName: 'Customers', address: 'D1', header: '', headerRow: 1, values: [['Follow-up'], ['Contact the dormant account'], ['No action']], reason: 'Suggested follow-up based on the observed login dates.', confidence: 0.8, reviewPriority: 'medium', requiresReview: true },
      { operation: 'write_cell', sheetName: 'Customers', address: 'E1', header: '', headerRow: 1, values: [['CLASSIFIED']], reason: 'The explicit request calls for this clear low-impact marker.', confidence: 0.95, reviewPriority: 'medium', requiresReview: false },
    ] },
  ];
  const autopilotProposals = [
    { phase: 'read_ranges', readRequests: [{ sheetName: 'Customers', range: 'A1:B3', purpose: 'Confirm the header row and inspect the customer values.' }], changes: [] },
    { phase: 'propose_changes', readRequests: [], changes: [
      { operation: 'write_cell', sheetName: 'Customers', address: 'F1', header: '', headerRow: 1, values: [['HIGH PRIORITY']], reason: 'This clear result is important enough to report after automatic processing.', confidence: 0.01, reviewPriority: 'high', requiresReview: false },
    ] },
  ];
  const fakeServer = `#!/usr/bin/env node
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const assistOutputs = ${JSON.stringify(proposals)};
const autopilotOutputs = ${JSON.stringify(autopilotProposals)};
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let turnIndex = 0;
let outputs = null;
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'codex-workbook-thread' } } });
  if (request.method === 'turn/start') {
    appendFileSync(process.env.CODEX_APP_SERVER_CAPTURE, JSON.stringify(request.params) + '\\n');
    const index = turnIndex++;
    if (index === 0) {
      const firstInput = (request.params.input ?? []).map((item) => item.text ?? '').join('\\n');
      outputs = firstInput.includes('Operational mode: autopilot') ? autopilotOutputs : assistOutputs;
    }
    const turnId = 'codex-workbook-turn-' + index;
    const output = outputs?.[index];
    if (!output) { send({ id: request.id, error: { message: 'Unexpected extra Codex turn.' } }); return; }
    send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'turn/completed', params: { threadId: 'codex-workbook-thread', turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(output) }] } } });
  }
});
`;
  let api;
  try {
    await writeFile(codexBinary, fakeServer, { mode: 0o755 });
    await chmod(codexBinary, 0o755);
    const apiPort = await availablePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    api = startApiServer(apiPort, dataDirectory, codexBinary, capturePath);
    await waitForApi(apiUrl, api);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Customers').addRows([['Account', 'Last Login'], ['Aki', '2024-01-01'], ['Mika', '2025-01-01']]);
    const source = Buffer.from(await workbook.xlsx.writeBuffer());
    const originalSource = Buffer.from(source);
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers.xlsx');
    const upload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: uploadForm });
    const uploadText = await upload.text();
    assert.equal(upload.status, 200, `XLSX upload failed: ${uploadText}`);
    const document = JSON.parse(uploadText);

    const analysis = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: 'Classify every customer by churn risk and add a concise follow-up column.',
        taskPlan: '', guidelines: 'Use recent login evidence; do not guess missing values.', correction: '', humanDecisions: '',
        documentId: document.documentId, documentScope: 'current', exportScope: 'current',
        pageText: '', imageDataUrl: 'data:image/png;base64,AA==', model: 'gpt-6-astra', pageNumber: 1, totalPages: 1,
        agentMode: 'assist', requireToolApproval: true, existingAnnotations: [], documentAnnotations: [], stream: true,
        settings: { provider: 'codex-app-server', reasoningEffort: 'low' },
      }),
    });
    const analysisText = await analysis.text();
    assert.equal(analysis.status, 200, `Codex workbook analysis failed: ${analysisText}`);
    assert.match(analysis.headers.get('content-type') ?? '', /text\/event-stream/);
    const result = readSseResult(analysisText);
    assert.equal(result.provider, 'codex-app-server');
    assert.equal(result.spreadsheetReviewCount, 3, 'header, value range, and follow-up range should all wait for approval');
    assert.deepEqual(result.spreadsheetChanges.map((change) => [change.operation, change.range, change.requiresReview]), [
      ['create_column', 'C1', true], ['write_range', 'C2:C3', true], ['write_range', 'D1:D3', true], ['write_cell', 'E1', false],
    ]);
    assert.ok(result.toolEvents.some((event) => event.toolName === 'read_range' && event.detail.includes('1 bounded workbook range')));

    const turnInputs = (await readFile(capturePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(turnInputs.length, 2);
    assert.equal(turnInputs[0].outputSchema.type, 'object');
    assert.equal(turnInputs[0].outputSchema.additionalProperties, false);
    assert.match(turnInputs[1].input[0].text, /Aki/);
    assert.match(turnInputs[1].input[0].text, /untrusted cell data/);

    const suggestUploadForm = new FormData();
    suggestUploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers-suggest.xlsx');
    const suggestUpload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: suggestUploadForm });
    const suggestUploadText = await suggestUpload.text();
    assert.equal(suggestUpload.status, 200, `Suggest XLSX upload failed: ${suggestUploadText}`);
    const suggestDocument = JSON.parse(suggestUploadText);
    const suggestAnalysis = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: 'Suggest a new churn-risk column and values for this workbook.',
        taskPlan: '', guidelines: '', correction: '', humanDecisions: '',
        documentId: suggestDocument.documentId, documentScope: 'current', exportScope: 'current',
        pageText: '', imageDataUrl: 'data:image/png;base64,AA==', model: 'gpt-6-astra', pageNumber: 1, totalPages: 1,
        agentMode: 'suggest', requireToolApproval: true, existingAnnotations: [], documentAnnotations: [],
        settings: { provider: 'codex-app-server', reasoningEffort: 'low' },
      }),
    });
    const suggestAnalysisText = await suggestAnalysis.text();
    assert.equal(suggestAnalysis.status, 200, `Codex Suggest workbook analysis failed: ${suggestAnalysisText}`);
    const suggestResult = JSON.parse(suggestAnalysisText);
    assert.equal(suggestResult.spreadsheetReviewCount, suggestResult.spreadsheetChanges.length);
    assert.ok(suggestResult.spreadsheetChanges.every((change) => change.requiresReview), 'Suggest mode must keep even clear Codex workbook proposals pending');
    const suggestWorkbookResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(suggestDocument.documentId)}/workbook/export`);
    const suggestWorkbook = new ExcelJS.Workbook();
    await suggestWorkbook.xlsx.load(Buffer.from(await suggestWorkbookResponse.arrayBuffer()));
    assert.equal(suggestWorkbook.getWorksheet('Customers')?.getCell('E1').value, null, 'Suggest mode applied a clear write without human review');

    const workbookExport = async () => {
      const response = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook/export`);
      if (!response.ok) throw new Error(`Workbook export failed (${response.status}): ${await response.text()}`);
      const restored = new ExcelJS.Workbook();
      await restored.xlsx.load(Buffer.from(await response.arrayBuffer()));
      return restored.getWorksheet('Customers');
    };
    let exportedSheet = await workbookExport();
    assert.equal(exportedSheet?.getCell('C1').value, null, 'Codex proposal analysis wrote the header before approval');
    assert.equal(exportedSheet?.getCell('C2').value, null, 'Codex proposal analysis wrote the cell values before approval');
    assert.equal(exportedSheet?.getCell('E1').value, 'CLASSIFIED', 'clear Assist-mode output was not auto-applied under the selected mode');

    const autopilotUploadForm = new FormData();
    autopilotUploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers-autopilot.xlsx');
    const autopilotUpload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: autopilotUploadForm });
    const autopilotUploadText = await autopilotUpload.text();
    assert.equal(autopilotUpload.status, 200, `Autopilot XLSX upload failed: ${autopilotUploadText}`);
    const autopilotDocument = JSON.parse(autopilotUploadText);
    const autopilotAnalysis = await fetch(`${apiUrl}/api/ai/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: 'Process clear customer classifications and report important cases.',
        taskPlan: '', guidelines: 'Report high-priority results; ask only when evidence is unclear.', correction: '', humanDecisions: '',
        documentId: autopilotDocument.documentId, documentScope: 'current', exportScope: 'current',
        pageText: '', imageDataUrl: 'data:image/png;base64,AA==', model: 'gpt-6-astra', pageNumber: 1, totalPages: 1,
        agentMode: 'autopilot', requireToolApproval: true, existingAnnotations: [], documentAnnotations: [], stream: true,
        settings: { provider: 'codex-app-server', reasoningEffort: 'low' },
      }),
    });
    const autopilotText = await autopilotAnalysis.text();
    assert.equal(autopilotAnalysis.status, 200, `Codex Autopilot workbook analysis failed: ${autopilotText}`);
    const autopilotResult = readSseResult(autopilotText);
    assert.equal(autopilotResult.spreadsheetReviewCount, 0, 'clear high-priority Autopilot results should be reported rather than held for approval');
    assert.deepEqual(autopilotResult.spreadsheetChanges.map((change) => [change.reviewPriority, change.requiresReview, change.approved]), [['high', false, true]]);
    const autopilotWorkbookResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(autopilotDocument.documentId)}/workbook/export`);
    assert.equal(autopilotWorkbookResponse.status, 200);
    const autopilotWorkbook = new ExcelJS.Workbook();
    await autopilotWorkbook.xlsx.load(Buffer.from(await autopilotWorkbookResponse.arrayBuffer()));
    assert.equal(autopilotWorkbook.getWorksheet('Customers')?.getCell('F1').value, 'HIGH PRIORITY', 'clear high-priority Autopilot output was not applied');

    await stopApi(api);
    api = startApiServer(apiPort, dataDirectory, codexBinary, capturePath);
    await waitForApi(apiUrl, api);
    const summaryResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook`);
    assert.equal(summaryResponse.status, 200, 'pending Codex proposals were not restored with the source session');
    const restoredSummary = await summaryResponse.json();
    assert.equal(restoredSummary.changes.length, 4);

    const decide = async (changeId, approved, sourceHash = document.sourceHash) => fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/workbook/changes/${encodeURIComponent(changeId)}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, sourceHash }),
    });
    const wrongSourceDecision = await decide(result.spreadsheetChanges[0].id, true, 'f'.repeat(64));
    assert.equal(wrongSourceDecision.status, 409, 'the direct workbook approval route accepted a stale source hash');
    const headerApprovals = await Promise.all([
      decide(result.spreadsheetChanges[0].id, true),
      decide(result.spreadsheetChanges[0].id, true),
    ]);
    assert.deepEqual(headerApprovals.map((response) => response.status).sort(), [200, 409], 'only one concurrent approval may apply a Codex workbook change');
    const approveHeader = headerApprovals.find((response) => response.status === 200);
    assert.ok(approveHeader);
    exportedSheet = await workbookExport();
    assert.equal(exportedSheet?.getCell('C1').value, 'Churn Risk');
    assert.equal(exportedSheet?.getCell('C2').value, null, 'approving only the header applied unapproved row values');

    const approveValues = await decide(result.spreadsheetChanges[1].id, true);
    assert.equal(approveValues.status, 200, `classification values approval failed: ${await approveValues.text()}`);
    const rejectFollowUp = await decide(result.spreadsheetChanges[2].id, false);
    assert.equal(rejectFollowUp.status, 200, `follow-up rejection failed: ${await rejectFollowUp.text()}`);
    exportedSheet = await workbookExport();
    assert.equal(exportedSheet?.getCell('C1').value, 'Churn Risk');
    assert.equal(exportedSheet?.getCell('C2').value, 'HIGH');
    assert.equal(exportedSheet?.getCell('C3').value, 'LOW');
    assert.equal(exportedSheet?.getCell('D1').value, null, 'rejecting the follow-up proposal changed the workbook');
    assert.equal(exportedSheet?.getCell('E1').value, 'CLASSIFIED');

    const reuploadForm = new FormData();
    reuploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers.xlsx');
    const reupload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: reuploadForm });
    const reuploadText = await reupload.text();
    assert.equal(reupload.status, 200, `re-upload after session eviction failed: ${reuploadText}`);
    const reuploadedDocument = JSON.parse(reuploadText);
    assert.notEqual(reuploadedDocument.documentId, document.documentId);
    const savedProposals = result.spreadsheetChanges.slice(0, 2).map((change) => ({
      id: change.id,
      documentId: reuploadedDocument.documentId,
      sourceHash: reuploadedDocument.sourceHash,
      target: { kind: 'sheet', sheet: change.sheetName, cellRange: change.range },
      label: change.operation === 'create_column' ? 'Create churn-risk column' : 'Classify customer churn risk',
      evidence: JSON.stringify(change.values), explanation: change.reason, reviewPriority: change.reviewPriority ?? 'high', status: 'needs_review',
      reason: change.reason, operation: change.operation, values: change.values, requiresReview: true,
    }));
    const decideReuploaded = (changeId, approved) => fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/changes/${encodeURIComponent(changeId)}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, sourceHash: reuploadedDocument.sourceHash }),
    });
    const beforeRestore = await decideReuploaded(savedProposals[0].id, true);
    assert.equal(beforeRestore.status, 404, 'test setup did not reproduce a proposal missing from the new session');
    const staleRestore = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: 'f'.repeat(64), documentAnnotations: savedProposals }),
    });
    assert.equal(staleRestore.status, 409, 'workbook restore accepted a proposal from a different source version');
    const staleRecordRestore = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: reuploadedDocument.sourceHash, documentAnnotations: savedProposals.map((record) => ({ ...record, sourceHash: 'f'.repeat(64) })) }),
    });
    assert.equal(staleRecordRestore.status, 409, 'workbook restore accepted an individual annotation from a different source version');
    const understatedProposal = { ...savedProposals[1], target: { ...savedProposals[1].target, cellRange: 'C2' } };
    const understatedRestore = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: reuploadedDocument.sourceHash, documentAnnotations: [understatedProposal] }),
    });
    assert.equal(understatedRestore.status, 400, 'workbook restore accepted values extending beyond their declared cell range');
    const emptyAfterRejectedRestore = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook`);
    assert.equal((await emptyAfterRejectedRestore.json()).changes.length, 0, 'an invalid range partially changed the workbook session');
    const restoreResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: reuploadedDocument.sourceHash, documentAnnotations: savedProposals }),
    });
    const restoredSummaryText = await restoreResponse.text();
    assert.equal(restoreResponse.status, 200, `saved workbook proposal restore failed: ${restoredSummaryText}`);
    const rehydratedSummary = JSON.parse(restoredSummaryText);
    assert.equal(rehydratedSummary.changes.length, 2);
    const restoredContext = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/changes/${encodeURIComponent(savedProposals[0].id)}/context`);
    assert.equal(restoredContext.status, 200, 'restored pending proposal did not regain its review context');
    const approveRestoredHeader = await decideReuploaded(savedProposals[0].id, true);
    assert.equal(approveRestoredHeader.status, 200, `re-uploaded header proposal could not be approved: ${await approveRestoredHeader.text()}`);
    const rejectRestoredValues = await decideReuploaded(savedProposals[1].id, false);
    assert.equal(rejectRestoredValues.status, 200, `re-uploaded cell proposal could not be rejected: ${await rejectRestoredValues.text()}`);
    const repeatedRestore = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: reuploadedDocument.sourceHash, documentAnnotations: savedProposals }),
    });
    assert.equal(repeatedRestore.status, 200, 'restoring the same workbook checkpoint was not idempotent');
    const repeatedSummary = await repeatedRestore.json();
    assert.equal(repeatedSummary.changes.find((change) => change.id === savedProposals[0].id)?.approved, true, 'repeated restore reset an approved proposal');
    assert.equal(repeatedSummary.changes.find((change) => change.id === savedProposals[1].id)?.rejected, true, 'repeated restore reset a rejected proposal');
    const reuploadedExport = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(reuploadedDocument.documentId)}/workbook/export`);
    assert.equal(reuploadedExport.status, 200);
    const reuploadedWorkbook = new ExcelJS.Workbook();
    await reuploadedWorkbook.xlsx.load(Buffer.from(await reuploadedExport.arrayBuffer()));
    const reuploadedSheet = reuploadedWorkbook.getWorksheet('Customers');
    assert.equal(reuploadedSheet?.getCell('C1').value, 'Churn Risk', 'restored approval was not applied to the new session');
    assert.equal(reuploadedSheet?.getCell('C2').value, null, 'restored rejection applied the proposed customer risk value');

    const raceUploadForm = new FormData();
    raceUploadForm.append('file', new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'customers.xlsx');
    const raceUpload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: raceUploadForm });
    const raceUploadText = await raceUpload.text();
    assert.equal(raceUpload.status, 200, `concurrent restore fixture upload failed: ${raceUploadText}`);
    const raceDocument = JSON.parse(raceUploadText);
    const competingProposals = [
      { id: 'concurrent-proposal-a', range: 'D2', value: 'A' },
      { id: 'concurrent-proposal-b', range: 'E2', value: 'B' },
    ].map(({ id, range, value }) => ({
      id, documentId: raceDocument.documentId, sourceHash: raceDocument.sourceHash,
      target: { kind: 'sheet', sheet: 'Customers', cellRange: range }, label: 'Workbook cell update', evidence: JSON.stringify([[value]]),
      explanation: 'Concurrent restore regression.', reviewPriority: 'medium', status: 'needs_review', reason: 'Confirm one restore wins.',
      operation: 'write_cell', values: [[value]], requiresReview: true,
    }));
    const raceRestores = await Promise.all(competingProposals.map((proposal) => fetch(`${apiUrl}/api/documents/${encodeURIComponent(raceDocument.documentId)}/workbook/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceHash: raceDocument.sourceHash, documentAnnotations: [proposal] }),
    })));
    assert.deepEqual(raceRestores.map((response) => response.status).sort(), [200, 409], 'competing workbook restores must not both replace the same session state');
    const winningProposal = competingProposals[raceRestores.findIndex((response) => response.status === 200)];
    const raceSummaryResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(raceDocument.documentId)}/workbook`);
    const raceSummary = await raceSummaryResponse.json();
    assert.deepEqual(raceSummary.changes.map((change) => change.id), [winningProposal.id], 'the losing restore overwrote or merged a competing proposal');
    assert.deepEqual(source, originalSource, 'Codex analysis and approvals must leave uploaded source bytes unchanged');
  } finally {
    await stopApi(api);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
