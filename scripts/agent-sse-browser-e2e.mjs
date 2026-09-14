import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliSession = `agent-sse-browser-e2e-${process.pid}-${Date.now()}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-agent-sse-browser-'));
const apiDataDirectory = join(temporaryDirectory, 'api-state');
const cliArtifactDirectory = join(temporaryDirectory, 'browser-cli');
const pdfFixturePath = join(temporaryDirectory, 'agent-sse-contract.pdf');
const screenshotDirectory = resolve(root, 'output/playwright/agent-sse');
const cliScript = resolve(root, 'node_modules/@playwright/cli/playwright-cli.js');
const children = [];
const providerRequests = [];
const providerErrors = [];
const scriptedCorrectionRule = 'Classify termination-for-convenience clauses with at least 30 days of written notice as LOW RISK.';
const scriptedTurns = [
  { name: 'open_document', arguments: {} },
  { name: 'get_document_info', arguments: {} },
  { name: 'get_document_outline', arguments: {} },
  { name: 'search_document', arguments: { query: 'termination' } },
  { name: 'inspect_page', arguments: {} },
  { name: 'navigate_page', arguments: { pageNumber: 2, reason: 'Search located the requested clause on page 2.' } },
  { name: 'inspect_page', arguments: {} },
  { name: 'scroll_document', arguments: { direction: 'down', amount: 0.12 } },
  { name: 'inspect_page', arguments: {} },
  { name: 'request_review', arguments: {
    x: 0.2, y: 0.32, width: 0.5, height: 0.1,
    label: 'HIGH RISK', note: 'Unilateral termination without cause.',
    reason: 'The visible clause allows either party to terminate without a breach condition.',
    excerpt: 'Either party may terminate for convenience on thirty days written notice.',
    confidence: 0.9, reviewPriority: 'high', requiresReview: true,
  } },
  { name: 'navigate_page', arguments: { pageNumber: 3, reason: 'Continue checking the remaining document after review.' } },
  { name: 'inspect_page', arguments: {} },
  { name: 'inspect_page', arguments: {} },
  { name: 'annotate_region', arguments: {
    x: 0.18, y: 0.28, width: 0.42, height: 0.08,
    label: 'LOW RISK', note: 'Thirty days of written notice satisfies the accepted correction rule.',
    reason: 'The termination clause provides the minimum notice required by the accepted rule.',
    excerpt: 'TERMINATION. End for convenience requires 30 days written notice.',
    confidence: 0.9, reviewPriority: 'low', requiresReview: false,
  } },
  { name: 'assistant', arguments: {} },
];

function spawnCaptured(name, args, env, cwd = root) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  const record = { name, child, get output() { return output; } };
  children.push(record);
  return record;
}

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

async function waitForResponse(url, record, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) {
      throw new Error(`${record.name} exited before readiness (${record.child.exitCode}).\n${record.output}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (await predicate(response)) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${record.name} did not become ready at ${url}: ${lastError}.\n${record.output}`);
}

async function waitForSuccessfulExit(record, timeoutMs = 60_000) {
  const { child } = record;
  if (child.exitCode !== null) {
    assert.equal(child.exitCode, 0, `${record.name} failed.\n${record.output}`);
    return;
  }
  const result = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolveExit({ code: null, signal: 'timeout' });
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  assert.equal(result.code, 0, `${record.name} did not finish successfully (${result.code ?? result.signal}).\n${record.output}`);
}

function runCli(...args) {
  return new Promise((resolveCli, rejectCli) => {
    const command = spawn(process.execPath, [cliScript, '--session', cliSession, ...args], {
      cwd: cliArtifactDirectory,
      env: { ...process.env, PLAYWRIGHT_CLI_SESSION: cliSession },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    command.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-24_000); });
    command.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-24_000); });
    command.once('error', rejectCli);
    command.once('exit', (code, signal) => {
      if (code !== 0) {
        rejectCli(new Error(`playwright-cli ${args.join(' ')} failed (${code ?? signal}).\n${stdout}\n${stderr}`));
        return;
      }
      resolveCli(`${stdout}${stderr}`);
    });
  });
}

async function stopChild(record) {
  const { child } = record;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function makeProviderServer(allowedBrowserOrigin) {
  let modelRequestIndex = 0;
  let releaseReviewResponse;
  const reviewResponseGate = new Promise((resolveGate) => { releaseReviewResponse = resolveGate; });
  let signalReviewResponseStarted;
  const reviewResponseStarted = new Promise((resolveStarted) => { signalReviewResponseStarted = resolveStarted; });
  let reviewStarted = false;
  let reviewReleased = false;

  const provider = createServer(async (request, response) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedBrowserOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/__e2e/review-status') {
      response.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ started: reviewStarted, released: reviewReleased }));
      return;
    }
    if (request.method === 'POST' && request.url === '/__e2e/release-review') {
      reviewReleased = true;
      releaseReviewResponse();
      response.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ released: true }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `Unexpected fake provider request: ${request.method} ${request.url}` }));
      return;
    }

    try {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk;
      const body = JSON.parse(rawBody);
      const requestRecord = { url: request.url, authorization: request.headers.authorization, body };
      providerRequests.push(requestRecord);
      if (body.text?.format?.name === 'annotation_task_plan') {
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
      if (body.text?.format?.name === 'annotation_correction_rule_draft') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'response-correction-rule', object: 'response', created_at: Math.floor(Date.now() / 1000),
          status: 'completed', model: 'gpt-6-astra',
          output: [{ id: 'message-correction-rule', type: 'message', role: 'assistant', status: 'completed', content: [{
            type: 'output_text', text: JSON.stringify({
              outcome: 'proposed_rule',
              rule: scriptedCorrectionRule,
              basis: 'The supplied guideline explicitly treats a 30-day notice period as LOW RISK.',
              reason: null,
            }), annotations: [],
          }] }],
          usage: { input_tokens: 6, output_tokens: 12, total_tokens: 18 },
        }));
        return;
      }

      const scripted = scriptedTurns[modelRequestIndex];
      if (!scripted) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: `response-validator-${modelRequestIndex}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
          status: 'completed', model: 'gpt-6-astra',
          output: [{ id: `message-validator-${modelRequestIndex}`, type: 'message', role: 'assistant', status: 'completed', content: [{
            type: 'output_text', text: JSON.stringify({ findings: [] }), annotations: [],
          }] }],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        }));
        return;
      }
      requestRecord.agentTurn = modelRequestIndex;
      requestRecord.agentTool = scripted.name;
      modelRequestIndex += 1;
      if (scripted.name === 'request_review') {
        reviewStarted = true;
        signalReviewResponseStarted();
        await reviewResponseGate;
      }
      const output = scripted.name === 'assistant'
        ? [{ id: `message-${modelRequestIndex}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The page-2 clause was reviewed, then the final page was annotated.', annotations: [] }] }]
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

  return {
    server: provider,
    reviewResponseStarted,
    get reviewReleased() { return reviewReleased; },
    releaseReviewResponse() { releaseReviewResponse(); },
  };
}

async function createPdfFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText('INTRODUCTION. This fictional document has a termination clause on page two.', { x: 50, y: 700, size: 14, font });
  pdf.addPage([612, 792]).drawText('TERMINATION. Either party may terminate for convenience on thirty days written notice.', { x: 50, y: 700, size: 14, font });
  pdf.addPage([612, 792]).drawText('TERMINATION. End for convenience requires 30 days written notice.', { x: 50, y: 700, size: 14, font });
  await writeFile(pdfFixturePath, Buffer.from(await pdf.save()));
}

let cliOpened = false;
let provider;
let api;
try {
  await mkdir(screenshotDirectory, { recursive: true });
  await mkdir(cliArtifactDirectory, { recursive: true });
  await createPdfFixture();

  const apiPort = await availablePort();
  let webPort = await availablePort();
  while (webPort === apiPort) webPort = await availablePort();
  let providerPort = await availablePort();
  while (providerPort === apiPort || providerPort === webPort) providerPort = await availablePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const appUrl = `http://127.0.0.1:${webPort}`;
    const providerUrl = `http://127.0.0.1:${providerPort}/v1`;
    const providerControlUrl = `http://127.0.0.1:${providerPort}/__e2e/release-review`;
    const providerStatusUrl = `http://127.0.0.1:${providerPort}/__e2e/review-status`;
  const fakeProvider = makeProviderServer(appUrl);
  provider = fakeProvider;
  await new Promise((resolveListen, reject) => {
    fakeProvider.server.once('error', reject);
    fakeProvider.server.listen(providerPort, '127.0.0.1', resolveListen);
  });

  api = spawnCaptured('local API', ['--import', 'tsx', 'server/index.ts'], {
    HOST: '127.0.0.1', PORT: String(apiPort), NODE_ENV: 'test',
    AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
    AZURE_OPENAI_DEPLOYMENT_GPT6: '', AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '',
    AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '', AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '',
    CODEX_APP_SERVER_DISABLED: 'true', CORS_ALLOWED_ORIGINS: appUrl,
    ANNOTATION_STUDIO_DATA_DIR: apiDataDirectory,
  });
  const healthResponse = await waitForResponse(`${apiUrl}/api/health`, api, async (response) => response.ok);
  const health = await healthResponse.json();
  assert.equal(health.aiConfigured, false, 'the API must have no configured real-provider credentials');
  assert.equal(health.codexAppServerConfigured, false, 'the API must not use the Codex provider');

  const build = spawnCaptured('Vite production build', [
    'node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native',
  ], {});
  await waitForSuccessfulExit(build);

  const web = spawnCaptured('Vite production preview', [
    'node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], { ANNOTATION_STUDIO_API_TARGET: apiUrl });
  await waitForResponse(appUrl, web, async (response) => response.ok);

  await runCli('open', 'about:blank');
  cliOpened = true;
  const browserScriptPath = join(cliArtifactDirectory, 'agent-sse-browser-flow.js');
  const browserScript = `async (page) => {
    const fail = (message) => { throw new Error('Agent SDK browser E2E assertion failed: ' + message); };
    const check = (condition, message) => { if (!condition) fail(message); };
    const equal = (actual, expected, message) => { if (actual !== expected) fail(message + '; expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); };
    const appUrl = ${JSON.stringify(appUrl)};
    const providerUrl = ${JSON.stringify(providerUrl)};
    const providerControlUrl = ${JSON.stringify(providerControlUrl)};
    const providerStatusUrl = ${JSON.stringify(providerStatusUrl)};
    const fixturePath = ${JSON.stringify(pdfFixturePath)};
    const screenshotDirectory = ${JSON.stringify(screenshotDirectory)};
    const originOf = (url) => url.split('/').slice(0, 3).join('/');
    const providerOrigin = originOf(providerUrl);
    const appOrigin = originOf(appUrl);
    const consoleErrors = [];
    const pageErrors = [];
    const externalRequests = [];
    const apiRequests = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/')) apiRequests.push({ url, method: request.method(), body: request.postData() });
    });
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const isHttp = url.startsWith('http://') || url.startsWith('https://');
      if (isHttp && !url.startsWith(appOrigin) && !url.startsWith(providerOrigin)) {
        externalRequests.push(url);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.addInitScript(() => {
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (...args) {
        if (this.download?.endsWith('-annotations.json')) {
          window.__agentSseExportFilename = this.download;
          window.__agentSseExportPromise = fetch(this.href).then(async (response) => {
            if (!response.ok) throw new Error('Annotation JSON blob returned HTTP ' + response.status + '.');
            window.__agentSseExportText = await response.text();
            return window.__agentSseExportText;
          });
        }
        return originalClick.apply(this, args);
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(appUrl);
    try {
      await page.getByRole('heading', { name: 'Visual Document Work Agent', exact: true }).waitFor({ state: 'visible', timeout: 12_000 });
    } catch (error) {
      const bodyText = await page.locator('body').innerText().catch(() => '(body unavailable)');
      fail('the production preview did not render the app heading; url=' + page.url() + '; title=' + await page.title().catch(() => '(title unavailable)') + '; body=' + bodyText.slice(0, 1200) + '; console=' + JSON.stringify(consoleErrors) + '; pageErrors=' + JSON.stringify(pageErrors) + '; cause=' + String(error));
    }
    await page.locator('#ai-prompt').waitFor({ state: 'visible' });
    await page.locator('.document-page-image').waitFor({ state: 'visible' });
    const initialHealth = await page.evaluate(async () => (await fetch('/api/health')).json());
    equal(initialHealth.aiConfigured, false, 'the production preview API unexpectedly has configured credentials');
    equal(initialHealth.codexAppServerConfigured, false, 'the Codex provider should stay disabled');

    await page.locator('.rail-settings').click();
    const settingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
    await settingsDialog.locator('#provider-mode').selectOption('openai-compatible');
    await settingsDialog.locator('#ai-endpoint').fill(providerUrl);
    await settingsDialog.locator('#api-key').fill('agent-sse-test-key');
    await settingsDialog.getByRole('button', { name: '設定を保存' }).click();
    const storedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('annotation-studio:settings:v1') || 'null'));
    check(storedSettings?.provider === 'openai-compatible' && storedSettings.endpoint === providerUrl, 'the fake provider setup was not saved: ' + JSON.stringify(storedSettings));
    check(await page.evaluate(() => !localStorage.getItem('annotation-studio:api-key:v1')), 'the test key must remain in memory instead of browser storage');

    const conversionResponsePromise = page.waitForResponse((response) => response.url().includes('/api/convert') && response.request().method() === 'POST', { timeout: 30_000 });
    await page.locator('.document-toolbar input[type="file"]').first().setInputFiles(fixturePath);
    const conversionResponse = await conversionResponsePromise;
    check(conversionResponse.ok(), 'the three-page PDF fixture upload failed with HTTP ' + conversionResponse.status());
    const document = await conversionResponse.json();
    equal(document.fileName, 'agent-sse-contract.pdf', 'the wrong source document was selected');
    equal(document.pageCount, 3, 'the fixture must contain exactly three pages');
    await page.getByText('agent-sse-contract.pdf', { exact: true }).first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const image = document.querySelector('.document-page-image');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    });
    await page.getByRole('tab', { name: /Agent/u }).click();
    await page.locator('#ai-prompt').waitFor({ state: 'visible' });
    await page.locator('#ai-prompt').fill('Find termination clauses on every page and classify their risk.');
    await page.locator('.guideline-details summary').click();
    await page.locator('#annotation-guidelines').fill('For termination-for-convenience clauses that provide at least 30 days of written notice, use LOW RISK.');

    const planResponsePromise = page.waitForResponse((response) => response.url().includes('/api/ai/plan') && response.request().method() === 'POST', { timeout: 30_000 });
    const annotateResponsePromise = page.waitForResponse((response) => response.url().includes('/api/ai/annotate') && response.request().method() === 'POST', { timeout: 45_000 });
    await page.getByRole('button', { name: '全ページを実行', exact: true }).click();
    const planResponse = await planResponsePromise;
    check(planResponse.ok(), 'the real Task Planner route failed with HTTP ' + planResponse.status());
    const planPayload = await planResponse.json();
    equal(planPayload.source, 'model', 'the UI should use the real Planner route backed by the fake Responses server');
    equal(planPayload.plan.title, 'Termination clause review', 'the modeled task plan was not applied in the UI');

    const activity = page.locator('section[aria-label="Agent Activity"]');
    try {
      await activity.getByText(/scroll_document →/u).first().waitFor({ state: 'visible', timeout: 45_000 });
    } catch (error) {
      const currentActivity = await activity.innerText().catch(() => '(activity unavailable)');
      const status = await page.locator('.agent-overview').innerText().catch(() => '(status unavailable)');
      fail('the UI never displayed streamed scroll_document activity; activity=' + currentActivity.slice(-2000) + '; status=' + status.slice(-800) + '; API requests=' + JSON.stringify(apiRequests.map((request) => request.url)) + '; cause=' + String(error));
    }
    const earlyActivityText = await activity.innerText();
    check(earlyActivityText.includes('navigate_page →'), 'the UI did not display streamed page-navigation activity');
    check(earlyActivityText.includes('scroll_document →'), 'the UI did not display streamed scroll activity');
    check(!(await page.locator('.candidate-section .candidate-card').count()), 'the review card must remain hidden until the Agent pause result is returned');
    const holdMetrics = await page.evaluate(() => {
      const root = document.querySelector('#root')?.getBoundingClientRect();
      const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
      return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: root?.width ?? 0, shellWidth: shell?.width ?? 0 };
    });
    equal(holdMetrics.rootWidth, 1440, 'the paused app root must span the full desktop viewport');
    equal(holdMetrics.shellWidth, 1440, 'the paused app shell must span the full desktop viewport');
    check(holdMetrics.scrollWidth <= holdMetrics.clientWidth, 'the paused screen has horizontal overflow');

    await page.waitForFunction(async (url) => {
      const response = await fetch(url);
      if (!response.ok) return false;
      return (await response.json()).started === true;
    }, providerStatusUrl, { timeout: 45_000 });

    const releaseResponse = await page.evaluate(async (url) => {
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) throw new Error('The local fake Responses gate returned HTTP ' + response.status + '.');
      return response.json();
    }, providerControlUrl);
    check(releaseResponse.released, 'the test did not release the scripted approval response');
    const annotateResponse = await annotateResponsePromise;
    check(annotateResponse.ok(), 'the real Agent SDK route failed with HTTP ' + annotateResponse.status());
    check((annotateResponse.headers()['content-type'] || '').includes('text/event-stream'), 'the browser request did not receive real API SSE');

    const reviewCard = page.locator('.candidate-section .candidate-card').filter({ hasText: 'HIGH RISK' }).first();
    await reviewCard.waitFor({ state: 'visible', timeout: 20_000 });
    check((await activity.innerText()).includes('request_review →'), 'the UI omitted the streamed request_review activity before showing its approval card');
    check((await reviewCard.innerText()).includes('Either party may terminate for convenience on thirty days written notice.'), 'the Human-in-the-loop card omitted the page-2 excerpt');
    check((await reviewCard.innerText()).includes('without a breach condition'), 'the Human-in-the-loop card omitted the review reason');
    await page.locator('.continuation-note').filter({ hasText: 'ページ 2' }).waitFor({ state: 'visible' });
    const pausedPageImage = await page.locator('.document-page-image').getAttribute('alt');
    check(pausedPageImage?.includes('2 ページ'), 'the approval card should focus page 2, got ' + pausedPageImage);
    await reviewCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshotDirectory + '/agent-sdk-review-waiting-1440x900.png', animations: 'disabled' });

    await reviewCard.getByRole('button', { name: '修正' }).click();
    const correctionEditor = reviewCard.locator('.candidate-correction-editor');
    await correctionEditor.locator('label').filter({ hasText: '修正ラベル' }).locator('input').fill('LOW RISK');
    await correctionEditor.locator('label').filter({ hasText: '修正メモ' }).locator('textarea').fill('A 30-day written notice period is sufficient. Classify this termination-for-convenience clause as LOW RISK.');
    const correctionRuleResponsePromise = page.waitForResponse((response) => response.url().includes('/api/ai/correction-rule') && response.request().method() === 'POST', { timeout: 45_000 });
    await correctionEditor.getByTestId('draft-correction-rule').click();
    const correctionRuleResponse = await correctionRuleResponsePromise;
    check(correctionRuleResponse.ok(), 'the real correction-rule route failed with HTTP ' + correctionRuleResponse.status());
    const correctionRuleRequest = correctionRuleResponse.request().postDataJSON();
    equal(correctionRuleRequest.input.sourceCandidate.label, 'HIGH RISK', 'the correction-rule route omitted the original page-2 candidate');
    equal(correctionRuleRequest.input.correction.label, 'LOW RISK', 'the correction-rule route omitted the user-corrected label');
    equal(correctionRuleRequest.input.correction.note, 'A 30-day written notice period is sufficient. Classify this termination-for-convenience clause as LOW RISK.', 'the correction-rule route omitted the user-corrected note');
    const correctionRulePayload = await correctionRuleResponse.json();
    equal(correctionRulePayload.draft.outcome, 'proposed_rule', 'the fake provider did not return a reusable rule proposal');
    const acceptedRule = correctionRulePayload.draft.rule;
    check(typeof acceptedRule === 'string' && acceptedRule.includes('30 days') && acceptedRule.includes('LOW RISK'), 'the proposed rule was not grounded in the corrected decision: ' + acceptedRule);
    const correctionRuleText = correctionEditor.getByTestId('correction-rule-text');
    await correctionRuleText.waitFor({ state: 'visible' });
    equal(await correctionRuleText.inputValue(), acceptedRule, 'the UI did not render the draft rule for human review');
    await correctionEditor.getByRole('button', { name: 'この案を残りページに適用' }).click();
    equal(await correctionEditor.locator('select').inputValue(), 'remaining_pages', 'the user acceptance did not set the rule scope to remaining pages');
    equal(await correctionRuleText.inputValue(), acceptedRule, 'accepting the rule changed its reviewed text');
    await page.screenshot({ path: screenshotDirectory + '/agent-sdk-correction-rule-accepted-1440x900.png', animations: 'disabled' });

    const approvalResponsePromise = page.waitForResponse((response) => response.url().includes('/api/ai/approve') && response.request().method() === 'POST', { timeout: 45_000 });
    await correctionEditor.getByRole('button', { name: '変更を反映して続行' }).click();
    const approvalResponse = await approvalResponsePromise;
    check(approvalResponse.ok(), 'clicking the UI approve action did not resume the real API Run: HTTP ' + approvalResponse.status());
    check((approvalResponse.headers()['content-type'] || '').includes('text/event-stream'), 'the real approval endpoint did not return resumed SSE');
    const resumedStreamBody = await approvalResponse.text();
    check(resumedStreamBody.includes('event: result'), 'the resumed API stream ended without its final result event');
    check(resumedStreamBody.includes('event: done'), 'the resumed API stream ended without its done event');
    const resultFrame = resumedStreamBody.split(/\\r?\\n\\r?\\n/u).find((frame) => frame.startsWith('event: result'));
    const resultData = resultFrame?.split(/\\r?\\n/u).find((line) => line.startsWith('data:'))?.slice(5).trim();
    const resumedResult = resultData ? JSON.parse(resultData) : null;
    check(resumedResult?.status === 'complete', 'the real API resumed the Agent but did not report complete: ' + JSON.stringify(resumedResult));
    check(resumedResult.annotations?.some((item) => item.label === 'LOW RISK' && item.pageNumber === 3), 'the real resumed API result did not contain the page-3 LOW RISK annotation: ' + JSON.stringify(resumedResult));
    const approvalRequest = approvalResponse.request().postDataJSON();
    equal(approvalRequest.approved, false, 'the UI correction request did not reject the model suggestion before resuming');
    equal(approvalRequest.sourceHash, document.sourceHash, 'the UI approval request was not bound to this source hash');
    check(approvalRequest.note.includes(acceptedRule), 'the UI did not pass the accepted remaining-page rule into real API approval feedback: ' + approvalRequest.note);
    check(approvalRequest.note.includes('[RULE FOR REMAINING PAGES]'), 'the UI did not mark accepted guidance as a remaining-page rule');
    check(typeof approvalRequest.runId === 'string' && approvalRequest.runId.length > 0, 'the UI approval request omitted the pending Run ID');
    check(typeof approvalRequest.approvalId === 'string' && approvalRequest.approvalId.length > 0, 'the UI approval request omitted the pending tool approval ID');

    await page.getByRole('tab', { name: /Agent/u }).click();
    await page.locator('.document-page-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.document-page-image')?.getAttribute('alt')?.includes('3 ページ') === true, undefined, { timeout: 45_000 });
    const correctedPageThreeBox = page.locator('.annotation-box').filter({ hasText: 'LOW RISK' });
    try {
      await correctedPageThreeBox.waitFor({ state: 'visible', timeout: 45_000 });
    } catch (error) {
      const annotationTexts = await page.locator('.annotation-box').allTextContents().catch(() => []);
      const currentActivity = await activity.innerText().catch(() => '(activity unavailable)');
      fail('the API returned page 3 but its annotation box was not visible; annotationTexts=' + JSON.stringify(annotationTexts) + '; activity=' + currentActivity.slice(-1500) + '; resumedResult=' + JSON.stringify({ status: resumedResult.status, visitedPages: resumedResult.visitedPages, annotations: resumedResult.annotations }) + '; cause=' + String(error));
    }
    await page.locator('.agent-overview .agent-status-pill.is-complete').waitFor({ state: 'visible', timeout: 45_000 });
    const continuedActivityText = await activity.innerText();
    check(continuedActivityText.includes('navigate_page →') && continuedActivityText.includes('annotate_region →'), 'the UI omitted resumed page-3 tool activity');
    check(continuedActivityText.includes('P.3') || continuedActivityText.includes('ページ 3'), 'the resumed Activity history did not identify page 3');
    const finalMetrics = await page.evaluate(() => {
      const root = document.querySelector('#root')?.getBoundingClientRect();
      const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
      return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: root?.width ?? 0, shellWidth: shell?.width ?? 0 };
    });
    equal(finalMetrics.rootWidth, 1440, 'the completed app root must span the full desktop viewport');
    equal(finalMetrics.shellWidth, 1440, 'the completed app shell must span the full desktop viewport');
    check(finalMetrics.scrollWidth <= finalMetrics.clientWidth, 'the completed screen has horizontal overflow');
    const completedToast = await page.locator('.toast').innerText();
    check(completedToast.includes('3/3ページ'), 'the resumed run did not update its completion message with all checked pages: ' + completedToast);
    check(!completedToast.includes('未処理'), 'the resumed run left a stale unprocessed-page message: ' + completedToast);
    const persistedRuns = await page.evaluate(({ fileName, sourceHash }) => {
      const raw = localStorage.getItem('annotation-studio:run-history:' + fileName + ':source:' + sourceHash);
      return raw ? JSON.parse(raw) : [];
    }, { fileName: 'agent-sse-contract.pdf', sourceHash: document.sourceHash });
    const persistedRun = persistedRuns[0];
    equal(persistedRun?.status, 'complete', 'the resumed run history did not finish as complete');
    check([1, 2, 3].every((pageNumber) => persistedRun.pageCoverage?.some((item) => item.pageNumber === pageNumber && item.status === 'checked')), 'the resumed run history omitted a checked page: ' + JSON.stringify(persistedRun?.pageCoverage));
    const pageThreeCoverage = persistedRun.pageCoverage.find((item) => item.pageNumber === 3);
    equal(pageThreeCoverage.findingCount, 1, 'repeated inspection counted the page-3 annotation more than once');
    const pageTwoCoverage = persistedRun.pageCoverage.find((item) => item.pageNumber === 2);
    equal(pageTwoCoverage.reviewCount, 0, 'the approved page-2 candidate remained in the page review count');
    await page.screenshot({ path: screenshotDirectory + '/agent-sdk-page3-annotated-1440x900.png', animations: 'disabled' });

    await page.locator('.export-menu-toggle').click();
    await page.getByRole('menuitem', { name: '構造化JSONを保存' }).click();
    await page.waitForFunction(() => typeof window.__agentSseExportText === 'string', undefined, { timeout: 15_000 });
    const exportResult = await page.evaluate(() => ({ filename: window.__agentSseExportFilename, serialized: window.__agentSseExportText }));
    check(exportResult.filename.endsWith('-annotations.json'), 'the UI export did not produce the annotation JSON filename');
    const exported = JSON.parse(exportResult.serialized);
    equal(exported.document.fileName, 'agent-sse-contract.pdf', 'the export referenced the wrong source PDF');
    equal(exported.reviewQueue.length, 0, 'the approved Human-in-the-loop card should be resolved in the export');
    const correctedPageTwo = exported.annotations.find((item) => item.label === 'LOW RISK' && item.pageNumber === 2);
    check(correctedPageTwo, 'the JSON export omitted the human-corrected page-2 finding');
    equal(correctedPageTwo.reviewedByHuman, true, 'the exported page-2 finding is not marked human reviewed');
    equal(correctedPageTwo.reviewOutcome, 'corrected', 'the page-2 user correction was not distinguished from a direct approval');
    const continued = exported.annotations.find((item) => item.label === 'LOW RISK' && item.pageNumber === 3);
    check(continued, 'the JSON export omitted the page-3 annotation created after the accepted correction rule');
    const correctedRecord = exported.documentAnnotations.find((item) => item.id === correctedPageTwo.id);
    equal(correctedRecord?.status, 'corrected', 'the export did not preserve the page-2 correction status');
    const continuedRecord = exported.documentAnnotations.find((item) => item.id === continued.id);
    equal(continuedRecord?.status, 'auto', 'the export did not preserve the page-3 automatic annotation status');

    const requestPaths = apiRequests.map((request) => request.url.includes('/api/') ? request.url.slice(request.url.indexOf('/api/')).split('?')[0] : '');
    check(requestPaths.includes('/api/ai/plan'), 'the production UI never reached the Planner API');
    check(requestPaths.includes('/api/ai/correction-rule'), 'the production UI never reached the correction-rule API');
    check(requestPaths.includes('/api/ai/annotate'), 'the production UI never reached the Agent API');
    check(requestPaths.includes('/api/ai/approve'), 'the production UI never reached the real approval API');
    equal(externalRequests.length, 0, 'the browser attempted non-loopback external requests: ' + externalRequests.join(', '));
    equal(consoleErrors.length, 0, 'unexpected browser console errors: ' + JSON.stringify(consoleErrors));
    equal(pageErrors.length, 0, 'unexpected browser page errors: ' + JSON.stringify(pageErrors));
    return JSON.stringify({ fileName: exported.document.fileName, approvalRunId: approvalRequest.runId, approvalId: approvalRequest.approvalId, approvedRule: acceptedRule, page2: correctedPageTwo.label, page3: continued.label, exportedRecords: exported.documentAnnotations.length, viewport: finalMetrics, apiPaths: requestPaths });
  }`;
  await writeFile(browserScriptPath, browserScript, 'utf8');
  let browserOutput;
  try {
    browserOutput = await runCli('run-code', '--filename', browserScriptPath);
  } catch (error) {
    throw new Error(`${String(error)}\nFake Responses requests: ${providerRequests.map((item) => `${item.agentTurn ?? item.body.text?.format?.name ?? item.body.input?.[0]?.role ?? 'unknown'}:${item.agentTool ?? item.body.input?.[0]?.name ?? ''}:accepted-rule=${JSON.stringify(item.body).includes(scriptedCorrectionRule)}`).join(', ')}\nAPI process output:\n${api.output}`);
  }
  assert.match(browserOutput, /agent-sse-contract\.pdf/u, 'the browser flow did not report the completed source document.\n' + browserOutput);

  await withTimeout(fakeProvider.reviewResponseStarted, 'the fake Responses server never received request_review', 45_000);
  assert.equal(fakeProvider.reviewReleased, true, 'the browser must hold the initial result until streamed review activity is visible');
  assert.deepEqual(providerErrors, [], `the fake Responses server reported errors: ${JSON.stringify(providerErrors)}`);
  assert.equal(providerRequests.length, scriptedTurns.length + 3, 'the Planner, correction-rule Planner, Agents SDK approval/resume, and final Validator should make the scripted number of Responses requests');
  assert.ok(providerRequests.every((item) => item.url === '/v1/responses' && item.authorization === 'Bearer agent-sse-test-key'), 'only the configured loopback-compatible endpoint should receive the test key');
  assert.ok(providerRequests.every((item) => item.body.store === false), 'Planner and Agents SDK requests should stay memory-only');
  const planRequest = providerRequests.find((item) => item.body.text?.format?.name === 'annotation_task_plan');
  assert.ok(planRequest, 'the UI did not use the loopback fake Responses API for planning');
  assert.ok(providerRequests.some((item) => Array.isArray(item.body.tools) && item.body.tools.length > 0), 'the UI did not use the real Agents SDK tool loop after planning');
  const reviewTurn = scriptedTurns.findIndex((turn) => turn.name === 'request_review');
  const resumedRequests = providerRequests.filter((item) => typeof item.agentTurn === 'number' && item.agentTurn > reviewTurn);
  assert.ok(resumedRequests.length > 0, 'the fake Responses API saw no same-Run provider calls after the rejected review candidate');
  assert.ok(resumedRequests.some((item) => JSON.stringify(item.body).includes(scriptedCorrectionRule)), 'the accepted rule was not visible to the fake Responses API after same-Run resume');

  console.log(`Provider-free production browser E2E passed: React UI edited the page-2 finding, drafted and explicitly accepted a remaining-page correction rule, sent approved:false plus the corrected decision through /api/ai/approve, resumed the same Run with the rule visible to the loopback fake Responses API, annotated page 3 as LOW RISK, and exported corrected and continued records. Responses calls: ${providerRequests.length} to 127.0.0.1 only; no external provider calls. Screenshots: ${screenshotDirectory}.`);
} finally {
  provider?.releaseReviewResponse();
  if (cliOpened) await runCli('close').catch(() => {});
  await runCli('delete-data').catch(() => {});
  await Promise.all(children.reverse().map(stopChild));
  if (provider?.server.listening) {
    await new Promise((resolveClose) => {
      provider.server.close(() => resolveClose());
      provider.server.closeAllConnections();
    });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function withTimeout(promise, message, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
