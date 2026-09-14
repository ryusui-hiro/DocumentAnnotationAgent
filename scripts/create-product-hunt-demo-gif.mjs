import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetDirectory = resolve(root, 'docs/product-hunt/assets');
const outputPath = join(assetDirectory, 'customer-feedback-annotation-demo.gif');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'astra-annotator-product-hunt-gif-'));
const children = [];

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
  await stat(join(root, 'public/demos/customer-feedback-demo.xlsx'));
  await run('npm', ['run', 'build']);

  const apiPort = await availablePort();
  let webPort = await availablePort();
  while (webPort === apiPort) webPort = await availablePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const appUrl = `http://127.0.0.1:${webPort}`;
  const api = startChild('isolated demo API', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    HOST: '127.0.0.1', PORT: String(apiPort), AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_DEPLOYMENT_GPT6: '',
    AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '', AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '',
    AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '', CODEX_APP_SERVER_DISABLED: 'true', CODEX_APP_SERVER_BIN: '',
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

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Visual Document Work Agent' }).waitFor({ state: 'visible' });
  await page.locator('.document-page-image').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.document-page-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  await page.waitForTimeout(700);

  await page.getByTestId('open-llm-demo-menu').click();
  await page.getByTestId('open-live-feedback-demo').waitFor({ state: 'visible' });
  await page.waitForTimeout(900);
  await page.getByTestId('open-live-feedback-demo').click();
  await page.getByRole('heading', { name: 'customer-feedback-demo.xlsx', exact: true }).waitFor({ state: 'visible' });
  await page.locator('.workbook-preview').waitFor({ state: 'visible' });
  await page.getByTestId('feedback-demo-notice').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const rootRect = document.querySelector('#root')?.getBoundingClientRect();
    return rootRect?.width === window.innerWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  });
  await page.waitForTimeout(800);

  const table = page.locator('.workbook-grid-scroll');
  await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(700);
  const scrollPanel = page.locator('.ai-content');
  await scrollPanel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(1800);

  await context.close();
  context = undefined;
  assert.equal(pageErrors.length, 0, `The recorded browser reported errors: ${pageErrors.join(' | ')}`);
  const videoPath = await recording.path();
  const palettePath = join(temporaryDirectory, 'palette.png');
  await run('ffmpeg', ['-y', '-ss', '2.4', '-i', videoPath, '-vf', 'fps=8,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff', '-frames:v', '1', palettePath], { stdio: 'ignore' });
  await run('ffmpeg', ['-y', '-ss', '2.4', '-i', videoPath, '-i', palettePath, '-lavfi', 'fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer', '-loop', '0', outputPath], { stdio: 'ignore' });
  const output = await stat(outputPath);
  console.log(`Created ${outputPath} (${Math.round(output.size / 1024)} KB).`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await Promise.all(children.reverse().map(stopChild));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
