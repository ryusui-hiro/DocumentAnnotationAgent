import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import 'dotenv/config';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetDirectory = resolve(root, 'docs/product-hunt/assets');
const outputPath = join(assetDirectory, 'termination-pdf-agent-demo.gif');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'astra-annotator-pdf-agent-gif-'));
const children = [];
const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const liveModel = process.env.ANNOTATION_STUDIO_LIVE_MODEL?.trim() || 'gpt-5.6-sol';
const supportedLiveModels = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
if (!supportedLiveModels.has(liveModel)) throw new Error(`Unsupported recording model: ${liveModel}`);
const isExecutable = (path) => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};
const bundledCodex = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
].find(isExecutable);
const codexBinary = process.env.CODEX_APP_SERVER_BIN?.trim() || bundledCodex || 'codex';
const loginStatus = spawnSync(codexBinary, ['login', 'status'], { encoding: 'utf8', timeout: 10_000 });
const codexAuthenticated = Boolean(loginStatus && loginStatus.status === 0 && /logged in/i.test(`${loginStatus.stdout ?? ''}\n${loginStatus.stderr ?? ''}`));
const liveProvider = codexAuthenticated ? 'codex-app-server' : openAiKey ? 'openai-api' : '';
if (!liveProvider) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw new Error('A live PDF Agent recording needs an authenticated Codex CLI or OPENAI_API_KEY. No model output was generated.');
}

function startChild(name, command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  const record = { name, child, get output() { return output; } };
  children.push(record);
  return record;
}

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

async function waitForResponse(url, record, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) throw new Error(`${record.name} exited before readiness (${record.child.exitCode}).\n${record.output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`${record.name} did not become ready: ${lastError}.\n${record.output}`);
}

async function stopChild(record) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  record.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => record.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
  ]);
  if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
}

async function run(command, args, options = {}) {
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun({ code, signal }));
  });
  if (result.code !== 0) throw new Error(`${command} exited with ${result.code ?? result.signal}.`);
}

let browser;
let context;
try {
  await mkdir(assetDirectory, { recursive: true });
  await stat(join(root, 'public/demos/product-hunt-termination-contract.pdf'));
  await run('npm', ['run', 'build']);

  const apiPort = await availablePort();
  let webPort = await availablePort();
  while (webPort === apiPort) webPort = await availablePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const appUrl = `http://127.0.0.1:${webPort}`;
  const api = startChild('isolated demo API', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    HOST: '127.0.0.1', PORT: String(apiPort), AI_PROVIDER: 'openai', OPENAI_API_KEY: openAiKey,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_DEPLOYMENT_GPT6: '',
    AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '', AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '',
    AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '', CODEX_APP_SERVER_DISABLED: liveProvider !== 'codex-app-server' ? 'true' : 'false',
    CODEX_APP_SERVER_BIN: codexBinary,
    ANNOTATION_STUDIO_DATA_DIR: join(temporaryDirectory, 'api-state'), NODE_ENV: 'test', CORS_ALLOWED_ORIGINS: appUrl,
  });
  await waitForResponse(`${apiUrl}/api/health`, api);

  const web = startChild('production preview', process.execPath, [
    'node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], { ANNOTATION_STUDIO_API_TARGET: apiUrl });
  await waitForResponse(appUrl, web);

  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    recordVideo: { dir: temporaryDirectory, size: { width: 1440, height: 1000 } },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const recording = page.video();
  const recordingStartedAt = Date.now();

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Visual Document Work Agent' }).waitFor({ state: 'visible' });
  await page.locator('.document-page-image').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.document-page-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });

  await page.locator('.rail-settings').click();
  const settings = page.getByRole('dialog', { name: '接続と使用量' });
  await settings.locator('#provider-mode').selectOption(liveProvider);
  if (liveProvider === 'codex-app-server') {
    await settings.getByRole('button', { name: 'モデル一覧を確認' }).click();
    await settings.locator('.codex-model-result').waitFor({ state: 'visible', timeout: 30_000 });
    const availableModels = await settings.locator('.codex-model-result').innerText();
    const selectedModelLabel = liveModel === 'gpt-6-astra' ? /GPT[- ]6 Astra|gpt-6-astra/i
      : liveModel === 'gpt-5.6-sol' ? /GPT[- ]5\.6[- ]Sol|gpt-5\.6-sol/i
        : liveModel === 'gpt-5.6-terra' ? /GPT[- ]5\.6[- ]Terra|gpt-5\.6-terra/i
          : /GPT[- ]5\.6[- ]Luna|gpt-5\.6-luna/i;
    assert.match(availableModels, selectedModelLabel, `The local Codex provider did not report ${liveModel}: ${availableModels}`);
  } else if (process.env.OPENAI_BASE_URL) {
    await settings.locator('#ai-endpoint').fill(process.env.OPENAI_BASE_URL);
  }
  await settings.locator('#settings-model').selectOption(liveModel);
  await settings.getByRole('button', { name: '設定を閉じる' }).click();

  await page.getByTestId('open-llm-demo-menu').click();
  await page.getByTestId('open-live-contract-demo').click();
  await page.getByRole('heading', { name: 'fictional-termination-contract-live.pdf', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('termination-demo-notice').waitFor({ state: 'visible' });
  await page.locator('.document-page-image').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.document-page-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  const liveDocumentReadyAt = Date.now();
  const pageRunButton = page.locator('.ai-run-button');
  assert.equal(await page.locator('.agent-mode-grid').getByRole('button', { name: /Autopilot/ }).getAttribute('aria-pressed'), 'true', 'The live contract demo should default to Autopilot.');
  await pageRunButton.waitFor({ state: 'visible' });
  const panel = page.locator('.ai-content');
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(500);

  const runStartedAt = Date.now();
  await pageRunButton.click();
  await page.waitForFunction(() => document.querySelector('.ai-run-button')?.disabled === true, undefined, { timeout: 10_000 });
  const resultDeadline = Date.now() + 180_000;
  let finalStatus = '';
  while (Date.now() < resultDeadline) {
    finalStatus = await page.locator('.agent-overview .agent-status-pill').innerText().catch(() => '');
    if (finalStatus === '完了' || finalStatus === '確認待ち' || finalStatus === '停止') break;
    await page.waitForTimeout(500);
  }
  assert.equal(finalStatus, '確認待ち', `The live PDF Agent should pause for a human decision on ambiguous clause wording: ${finalStatus}`);
  const candidateCard = page.locator('.candidate-section .candidate-card').first();
  await candidateCard.waitFor({ state: 'visible', timeout: 20_000 });
  const reviewedPage = await candidateCard.locator('.candidate-page').innerText();
  const reviewedExcerpt = await candidateCard.locator('.candidate-excerpt').innerText();
  const resultState = await page.evaluate(() => ({
    annotationCount: document.querySelectorAll('.annotation-box:not(.annotation-candidate-box)').length,
    reviewCount: document.querySelectorAll('.candidate-card').length,
    modelActivity: document.querySelector('section[aria-label="Agent Activity"]')?.innerText ?? '',
    documentTitle: document.querySelector('.agent-overview-file strong')?.textContent ?? '',
  }));
  assert.ok(resultState.annotationCount + resultState.reviewCount > 0, 'The live model returned no visible annotations or review findings.');
  assert.ok(resultState.reviewCount > 0, 'The live PDF run must leave its uncertain clause for human review.');
  assert.match(resultState.modelActivity, /Codex|inspect_page|annotate_region|request_review|Validator|検索|注釈/u, 'The recording did not contain real Agent activity.');
  const reviewedPageNumber = Number(reviewedPage.match(/P\.(\d+)/u)?.[1]);
  assert.ok(Number.isInteger(reviewedPageNumber) && reviewedPageNumber > 0, `The review candidate has no valid page target: ${reviewedPage}`);
  await candidateCard.locator('.candidate-page').click();
  await page.waitForFunction((pageNumber) => Number(document.querySelector('.page-controls strong')?.textContent) === pageNumber, reviewedPageNumber, { timeout: 15_000 });
  await page.locator('.annotation-candidate-box').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(1800);

  await context.close();
  context = undefined;
  assert.equal(pageErrors.length, 0, `The recorded browser reported errors: ${pageErrors.join(' | ')}`);
  const videoPath = await recording.path();
  const palettePath = join(temporaryDirectory, 'palette.png');
  const trimStart = Math.max(0, (liveDocumentReadyAt - recordingStartedAt) / 1000 - 0.2);
  const seek = trimStart.toFixed(2);
  const speed = '0.3';
  await run('ffmpeg', ['-y', '-ss', seek, '-i', videoPath, '-vf', `setpts=${speed}*PTS,fps=6,scale=960:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff`, '-frames:v', '1', palettePath], { stdio: 'ignore' });
  await run('ffmpeg', ['-y', '-ss', seek, '-i', videoPath, '-i', palettePath, '-lavfi', `setpts=${speed}*PTS,fps=6,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`, '-loop', '0', outputPath], { stdio: 'ignore' });
  const output = await stat(outputPath);
  console.log(`Created ${outputPath} (${Math.round(output.size / 1024)} KB); the live Agent applied ${resultState.annotationCount} annotation(s), queued ${resultState.reviewCount} finding(s) for review on ${reviewedPage} (${reviewedExcerpt}), using ${liveModel} via ${liveProvider}.`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await Promise.all(children.reverse().map(stopChild));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
