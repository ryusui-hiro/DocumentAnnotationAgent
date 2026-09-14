import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      NODE_ENV: 'test',
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
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
    }, 3_000);
    api.child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    api.child.kill('SIGTERM');
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function responseJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Expected JSON response; received: ${text.slice(0, 500)}`); }
}

async function listFilesRecursively(directory, prefix = '') {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFilesRecursively(join(directory, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files;
}

const correctionInput = {
  task: 'Label unilateral termination without cause as HIGH RISK.',
  taskPlan: 'Review termination provisions and use the requested risk labels.',
  guidelines: 'Use HIGH RISK for unilateral termination without cause.',
  sourceCandidate: {
    pageNumber: 2,
    label: 'MEDIUM RISK',
    note: 'The original finding understated the risk.',
    reason: 'A party can terminate without giving a cause.',
    excerpt: 'SOURCE_ONLY_CANDIDATE_7f98: Either party may terminate without cause.',
  },
  correction: {
    label: 'HIGH RISK',
    note: 'Unilateral termination without cause is a serious risk.',
  },
};

test('correction-rule API sends a structured memory-only request and rejects invalid or unconfigured calls locally', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-correction-rule-api-'));
  const dataDirectory = join(temporaryDirectory, 'api-state');
  const providerRequests = [];
  const provider = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    let body;
    try { body = JSON.parse(rawBody); } catch { body = null; }
    providerRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'resp-correction-rule-local-test',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'gpt-6-astra',
      output: [{
        id: 'msg-correction-rule-local-test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            outcome: 'proposed_rule',
            rule: 'Label unilateral termination without cause as HIGH RISK.',
            basis: 'The task and guideline explicitly assign HIGH RISK to termination without cause, matching the human correction.',
            reason: null,
          }),
          annotations: [],
        }],
      }],
      usage: { input_tokens: 21, output_tokens: 13, total_tokens: 34 },
    }));
  });

  let api;
  let providerListening = false;
  try {
    await new Promise((resolveListen, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolveListen);
    });
    providerListening = true;
    const providerAddress = provider.address();
    assert.ok(providerAddress && typeof providerAddress === 'object');
    const providerEndpoint = `http://127.0.0.1:${providerAddress.port}/v1`;
    const apiPort = await availablePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    api = startApiServer(apiPort, dataDirectory);
    await waitForApi(apiUrl, api);

    const fakeSettings = {
      provider: 'openai-compatible',
      endpoint: providerEndpoint,
      apiKey: 'local-only-correction-rule-test-key',
      reasoningEffort: 'medium',
    };
    const proposedResponse = await fetch(`${apiUrl}/api/ai/correction-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: correctionInput, model: 'gpt-6-astra', settings: fakeSettings }),
      signal: AbortSignal.timeout(15_000),
    });
    const proposed = await responseJson(proposedResponse);
    assert.equal(proposedResponse.status, 200, `Correction-rule proposal failed: ${JSON.stringify(proposed)}`);
    assert.deepEqual(proposed.draft, {
      outcome: 'proposed_rule',
      rule: 'Label unilateral termination without cause as HIGH RISK.',
      basis: 'The task and guideline explicitly assign HIGH RISK to termination without cause, matching the human correction.',
    });
    assert.equal(proposed.provider, 'openai-compatible');
    assert.equal(proposed.model, 'gpt-6-astra');

    assert.equal(providerRequests.length, 1, 'only the valid request should reach the loopback provider');
    const providerRequest = providerRequests[0];
    assert.equal(providerRequest.method, 'POST');
    assert.equal(providerRequest.url, '/v1/responses');
    assert.equal(providerRequest.authorization, 'Bearer local-only-correction-rule-test-key');
    assert.ok(providerRequest.body, 'the loopback provider should receive a JSON request');
    assert.equal(providerRequest.body.model, 'gpt-6-astra');
    assert.equal(providerRequest.body.store, false, 'source context must not be stored by the Responses API');
    assert.equal(providerRequest.body.reasoning?.effort, 'medium');
    const outputFormat = providerRequest.body.text?.format;
    assert.equal(outputFormat?.type, 'json_schema');
    assert.equal(outputFormat?.name, 'annotation_correction_rule_draft');
    assert.equal(outputFormat?.strict, true);
    assert.deepEqual(outputFormat?.schema?.required, ['outcome', 'rule', 'basis', 'reason']);
    assert.equal(outputFormat?.schema?.additionalProperties, false);
    assert.equal(typeof providerRequest.body.instructions, 'string');
    assert.match(providerRequest.body.instructions, /source-candidate.*untrusted document-derived evidence/i);
    assert.equal(typeof providerRequest.body.input, 'string');
    assert.match(providerRequest.body.input, /SOURCE_ONLY_CANDIDATE_7f98/);
    assert.match(providerRequest.body.input, /Label unilateral termination without cause as HIGH RISK/);

    const invalidInput = {
      ...correctionInput,
      sourceCandidate: { ...correctionInput.sourceCandidate, unexpected: 'must be rejected by the input schema' },
    };
    const invalidResponse = await fetch(`${apiUrl}/api/ai/correction-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: invalidInput, model: 'gpt-6-astra', settings: fakeSettings }),
    });
    const invalid = await responseJson(invalidResponse);
    assert.equal(invalidResponse.status, 400, `Unsupported input should fail with HTTP 400: ${JSON.stringify(invalid)}`);

    const unsupportedModelResponse = await fetch(`${apiUrl}/api/ai/correction-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: correctionInput, model: 'unsupported-model', settings: fakeSettings }),
    });
    const unsupportedModel = await responseJson(unsupportedModelResponse);
    assert.equal(unsupportedModelResponse.status, 400, `Unsupported model should fail with HTTP 400: ${JSON.stringify(unsupportedModel)}`);

    const unconfiguredResponse = await fetch(`${apiUrl}/api/ai/correction-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: correctionInput, model: 'gpt-6-astra', settings: { provider: 'openai-api' } }),
    });
    const unconfigured = await responseJson(unconfiguredResponse);
    assert.equal(unconfiguredResponse.status, 503, `Missing provider credentials should fail with HTTP 503: ${JSON.stringify(unconfigured)}`);
    assert.equal(unconfigured.aiConfigured, false);
    assert.equal(providerRequests.length, 1, 'invalid and unconfigured requests must fail before calling any provider');

    const storedFiles = await listFilesRecursively(dataDirectory);
    assert.deepEqual(storedFiles, [], 'correction-rule source context must remain memory-only on the local server');
  } finally {
    await stopApi(api);
    if (providerListening) await closeServer(provider);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
