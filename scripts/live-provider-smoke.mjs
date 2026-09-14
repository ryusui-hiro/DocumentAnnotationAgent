import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { taskPlanAsInstructions } from '../src/taskPlan.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.env.ANNOTATION_STUDIO_LIVE_SMOKE !== '1') {
  throw new Error('This acceptance flow can contact an AI provider and may incur charges. Set ANNOTATION_STUDIO_LIVE_SMOKE=1 only when you intentionally want to run it.');
}

const model = process.env.ANNOTATION_STUDIO_LIVE_MODEL || 'gpt-6-astra';
const provider = process.env.ANNOTATION_STUDIO_LIVE_PROVIDER
  || (process.env.AI_PROVIDER === 'azure' ? 'azure-openai' : 'openai-api');
if (!['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].includes(model)) throw new Error('Unsupported smoke-test model.');
if (!['openai-api', 'azure-openai', 'openai-compatible'].includes(provider)) throw new Error('Use OpenAI, Azure OpenAI, or an OpenAI-compatible provider for this smoke test.');

const apiKey = provider === 'azure-openai' ? process.env.AZURE_OPENAI_API_KEY : process.env.OPENAI_API_KEY;
const endpoint = provider === 'azure-openai'
  ? process.env.AZURE_OPENAI_ENDPOINT
  : process.env.OPENAI_BASE_URL || (provider === 'openai-api' ? 'https://api.openai.com/v1' : '');
const azureDeployment = process.env[`AZURE_OPENAI_DEPLOYMENT_${model === 'gpt-6-astra' ? 'GPT6' : model === 'gpt-5.6-sol' ? 'GPT56_SOL' : model === 'gpt-5.6-terra' ? 'GPT56_TERRA' : 'GPT56_LUNA'}`] || '';
if (!apiKey?.trim()) throw new Error(`Set ${provider === 'azure-openai' ? 'AZURE_OPENAI_API_KEY' : 'OPENAI_API_KEY'} before running this opt-in smoke test.`);
if (!endpoint?.trim()) throw new Error(provider === 'azure-openai' ? 'Set AZURE_OPENAI_ENDPOINT.' : 'Set OPENAI_BASE_URL for the selected provider.');
if (provider === 'azure-openai' && !azureDeployment.trim()) throw new Error('Set the Azure deployment variable for the selected model.');

async function availablePort() {
  const probe = createServer();
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

function startApi(port, dataDirectory) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      AI_PROVIDER: provider === 'azure-openai' ? 'azure' : 'openai',
      OPENAI_API_KEY: provider === 'openai-api' || provider === 'openai-compatible' ? apiKey : '',
      OPENAI_BASE_URL: provider === 'openai-api' || provider === 'openai-compatible' ? endpoint : '',
      AZURE_OPENAI_API_KEY: provider === 'azure-openai' ? apiKey : '',
      AZURE_OPENAI_ENDPOINT: provider === 'azure-openai' ? endpoint : '',
      [`AZURE_OPENAI_DEPLOYMENT_${model === 'gpt-6-astra' ? 'GPT6' : model === 'gpt-5.6-sol' ? 'GPT56_SOL' : model === 'gpt-5.6-terra' ? 'GPT56_TERRA' : 'GPT56_LUNA'}`]: azureDeployment,
      CODEX_APP_SERVER_DISABLED: 'true',
      ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  return { child, get output() { return output; } };
}

async function waitForApi(baseUrl, api, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`The local API exited before readiness (${api.child.exitCode}).\n${api.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`The local API did not become ready: ${lastError}.\n${api.output}`);
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

const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-live-smoke-'));
const port = await availablePort();
const api = startApi(port, join(directory, 'api-state'));
try {
  const apiUrl = `http://127.0.0.1:${port}`;
  await waitForApi(apiUrl, api);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('TERMINATION TERMS', { x: 60, y: 700, size: 18, font, color: rgb(0.1, 0.2, 0.25) });
  page.drawText('Either party may terminate for convenience on thirty (30) days written notice, without cause.', { x: 60, y: 650, size: 12, font });
  page.drawText('Either party may terminate for material breach only if it remains uncured thirty (30) days after notice.', { x: 60, y: 600, size: 12, font });
  const pdfBytes = Buffer.from(await pdf.save());
  const upload = new FormData();
  upload.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'synthetic-termination-smoke.pdf');
  const convertResponse = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: upload });
  const converted = await convertResponse.json();
  if (!convertResponse.ok) throw new Error(`Synthetic PDF conversion failed (${convertResponse.status}): ${converted.error ?? 'unknown error'}`);

  const sourcePage = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(converted.documentId)}/pages/1.svg`);
  if (!sourcePage.ok) throw new Error(`Could not read the converted page image (${sourcePage.status}).`);
  const pagePng = await sharp(Buffer.from(await sourcePage.arrayBuffer())).png().toBuffer();
  const instructions = 'Find both termination provisions. Label unilateral termination without cause as HIGH RISK and termination conditioned on an uncured material breach as MEDIUM RISK. Use the document tools, cite visible evidence, and request human approval for the HIGH RISK finding.';
  const settings = {
    provider,
    apiKey,
    endpoint,
    reasoningEffort: 'medium',
    ...(provider === 'azure-openai' ? { azureDeployment } : {}),
  };
  const taskResponse = await fetch(`${apiUrl}/api/ai/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: instructions, guidelines: '', correction: '', mode: 'assist', model, settings }),
  });
  const planned = await taskResponse.json();
  if (!taskResponse.ok || !planned.plan) throw new Error(`Task planning failed (${taskResponse.status}): ${planned.error ?? 'No structured plan returned.'}`);

  const runResponse = await fetch(`${apiUrl}/api/ai/annotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: instructions,
      taskPlan: taskPlanAsInstructions(planned.plan),
      guidelines: 'Use HIGH RISK for unilateral termination without cause. Use MEDIUM RISK for termination only after uncured material breach.',
      correction: '', humanDecisions: '', documentId: converted.documentId,
      documentScope: 'current', exportScope: 'current', pageText: 'TERMINATION TERMS. Either party may terminate for convenience on thirty (30) days written notice, without cause. Either party may terminate for material breach only if it remains uncured thirty (30) days after notice.',
      imageDataUrl: `data:image/png;base64,${pagePng.toString('base64')}`,
      model, pageNumber: 1, totalPages: converted.pageCount, agentMode: 'assist',
      requireToolApproval: true, existingAnnotations: [], documentAnnotations: [], settings,
    }),
  });
  const firstResult = await runResponse.json();
  if (!runResponse.ok) throw new Error(`Agent analysis failed (${runResponse.status}): ${firstResult.error ?? 'unknown error'}`);
  if (firstResult.status !== 'interrupted' || !firstResult.approvalRunId || !firstResult.approvalId) {
    throw new Error(`The live Agent did not pause for human review. Result status: ${String(firstResult.status ?? 'missing')}.`);
  }

  const approveResponse = await fetch(`${apiUrl}/api/ai/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: firstResult.approvalRunId,
      approvalId: firstResult.approvalId,
      approved: true,
      sourceHash: converted.sourceHash,
      settings,
    }),
  });
  const resumed = await approveResponse.json();
  if (!approveResponse.ok || resumed.status !== 'complete') throw new Error(`The approved RunState did not finish (${approveResponse.status}): ${resumed.error ?? resumed.status ?? 'unknown error'}`);

  const exportResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(converted.documentId)}/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'annotations-json' }),
  });
  const exported = await exportResponse.json();
  if (!exportResponse.ok || !Array.isArray(exported.documentAnnotations)) throw new Error(`Structured export failed (${exportResponse.status}).`);
  const approvedCount = exported.documentAnnotations.filter((annotation) => annotation.status === 'approved' || annotation.status === 'corrected').length;
  if (approvedCount < 1) throw new Error('The approved finding was missing from structured JSON export.');
  process.stdout.write(`Live provider smoke passed: ${provider}/${model}; structured planning, document tools, human-review interruption/resume, and JSON export. ${approvedCount} confirmed annotation(s).\n`);
} finally {
  await stopApi(api);
  await rm(directory, { recursive: true, force: true });
}
