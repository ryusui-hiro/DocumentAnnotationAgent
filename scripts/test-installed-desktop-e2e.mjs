import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('Skipping installed Tauri package E2E; official tauri-driver/WebKitWebDriver coverage runs in the Ubuntu CI job.');
  process.exit(0);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const debPathArg = process.argv[2];
assert.ok(debPathArg, 'Pass the installed .deb path as the first argument.');
const debPath = resolve(debPathArg);
const packageName = execFileSync('dpkg-deb', ['-f', debPath, 'Package'], { encoding: 'utf8' }).trim();
// The bundled runtime contains enough files for dpkg -L to exceed Node's 1 MiB default.
const installedFiles = execFileSync('dpkg', ['-L', packageName], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').filter(Boolean);
const appBinaryCandidate = installedFiles.find((path) => basename(path) === 'annotation-studio');
assert.ok(appBinaryCandidate, `Installed package ${packageName} does not contain the annotation-studio executable.`);
const appBinary = await realpath(appBinaryCandidate);
await access(appBinary, fsConstants.X_OK);

const tempRoot = await mkdtemp(join(tmpdir(), 'annotation-studio-installed-e2e-'));
const apiDataDirectory = join(tempRoot, 'api-state');
const runtimeDirectories = {
  XDG_CACHE_HOME: join(tempRoot, 'xdg-cache'),
  XDG_CONFIG_HOME: join(tempRoot, 'xdg-config'),
  XDG_DATA_HOME: join(tempRoot, 'xdg-data'),
};
const inheritedEnvironmentKeys = [
  'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'TZ',
];
const testEnvironment = {
  ...Object.fromEntries(inheritedEnvironmentKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  HOME: tempRoot,
  TMPDIR: tempRoot,
  ...runtimeDirectories,
  ANNOTATION_STUDIO_DATA_DIR: apiDataDirectory,
  ANNOTATION_STUDIO_FORCE_SIDECAR: '1',
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
};
const tauriDriverCommand = process.env.TAURI_DRIVER_PATH || 'tauri-driver';
const portPairs = await reservePortPair();
const driverBaseUrl = `http://127.0.0.1:${portPairs.driverPort}`;
const driver = spawn(tauriDriverCommand, ['--port', String(portPairs.driverPort), '--native-port', String(portPairs.nativePort)], {
  cwd: projectRoot,
  env: testEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let driverOutput = '';
driver.stdout.setEncoding('utf8').on('data', (chunk) => { driverOutput = `${driverOutput}${chunk}`.slice(-16_000); });
driver.stderr.setEncoding('utf8').on('data', (chunk) => { driverOutput = `${driverOutput}${chunk}`.slice(-16_000); });

let sessionId;
let appProcess;
let sidecarProcess;
let apiPort;
let sessionClosedNormally = false;

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function reservePortPair() {
  const driverPort = await reservePort();
  let nativePort = await reservePort();
  while (nativePort === driverPort) nativePort = await reservePort();
  return { driverPort, nativePort };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(description, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited before ${description} (${driver.exitCode}).\n${driverOutput}`);
    try {
      const result = await operation();
      if (result) return result;
      lastError = 'condition is still false';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError}.\n${driverOutput}`);
}

async function driverRequest(method, path, body, timeoutMs = 60_000) {
  const response = await fetch(`${driverBaseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (!response.ok || payload.value?.error) {
    const detail = payload.value?.message ?? payload.value?.error ?? payload.message ?? text;
    throw new Error(`WebDriver ${method} ${path} failed (HTTP ${response.status}): ${detail}`);
  }
  return payload;
}

async function sessionCommand(method, suffix, body, timeoutMs) {
  assert.ok(sessionId, 'A WebDriver session has not been created.');
  return driverRequest(method, `/session/${sessionId}${suffix}`, body, timeoutMs);
}

async function executeScript(script, args = []) {
  const result = await sessionCommand('POST', '/execute/sync', { script, args }, 30_000);
  return result.value;
}

async function executeAsyncScript(script, args = [], timeoutMs = 30_000) {
  const result = await sessionCommand('POST', '/execute/async', { script, args }, timeoutMs);
  return result.value;
}

async function waitForScript(description, script, args = [], timeoutMs = 45_000) {
  return waitFor(description, async () => {
    const value = await executeScript(script, args);
    return value ? value : false;
  }, timeoutMs);
}

function parseProcEnvironment(raw) {
  const values = new Map();
  for (const entry of raw.toString('utf8').split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return values;
}

async function readProcInfo(pid) {
  try {
    const [cmdline, environ, status, executable] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/environ`),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readlink(`/proc/${pid}/exe`),
    ]);
    const parentPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
    return {
      pid: Number(pid),
      parentPid,
      cmdline: cmdline.toString('utf8').replaceAll('\0', ' ').trim(),
      environment: parseProcEnvironment(environ),
      executable,
    };
  } catch {
    return null;
  }
}

async function procEntries() {
  return (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
}

async function findInstalledAppProcess() {
  const pids = await procEntries();
  for (const pid of pids) {
    const entry = await readProcInfo(pid);
    if (entry?.executable === appBinary && entry.environment.get('ANNOTATION_STUDIO_DATA_DIR') === apiDataDirectory) return entry;
  }
  return null;
}

async function findSidecarProcess() {
  const pids = await procEntries();
  for (const pid of pids) {
    const entry = await readProcInfo(pid);
    if (!entry || !entry.cmdline.includes('desktop-api-launcher.mjs')) continue;
    if (entry.environment.get('ANNOTATION_STUDIO_DATA_DIR') !== apiDataDirectory) continue;
    const port = Number(entry.environment.get('PORT'));
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return { ...entry, port };
  }
  return null;
}

async function processStillMatches(pid, expected) {
  const current = await readProcInfo(pid);
  if (!current) return false;
  if (expected.kind === 'app') {
    return current.executable === appBinary
      && current.environment.get('ANNOTATION_STUDIO_DATA_DIR') === apiDataDirectory;
  }
  return current.cmdline.includes('desktop-api-launcher.mjs')
    && current.environment.get('ANNOTATION_STUDIO_DATA_DIR') === apiDataDirectory
    && Number(current.environment.get('PORT')) === expected.port;
}

async function httpJson(url, timeoutMs = 2_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json();
  return { response, payload };
}

async function checkPortRefused(port) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (refused) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(refused);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1_000, () => finish(false));
  });
}

function createWorkspaceFixture(document) {
  return {
    fileName: document.fileName,
    documentId: document.documentId,
    sourceHash: document.sourceHash,
    fileType: document.fileType,
  };
}

const installEmptyWorkspaceScript = `
  const fixture = arguments[0];
  localStorage.clear();
  const baseKey = 'annotation-studio:annotations:' + fixture.fileName;
  const versionKey = baseKey + ':source:' + fixture.sourceHash;
  const state = {
    version: 4,
    sourceHash: fixture.sourceHash,
    documentId: fixture.documentId,
    fileType: fixture.fileType,
    documentAnnotations: [],
    annotationOperations: [],
    consistencyIssues: [],
    preparedExports: [],
    continuation: null,
    task: {},
  };
  localStorage.setItem(versionKey, JSON.stringify(state));
  localStorage.setItem(baseKey, JSON.stringify({ version: 4, sourceHash: fixture.sourceHash, workspaceKey: versionKey }));
  return true;
`;

const installJsonAnchorHookScript = `
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (this.download && this.download.endsWith('-annotations.json')) {
      window.__installedDesktopE2eExport = fetch(this.href).then(async (response) => {
        if (!response.ok) throw new Error('JSON Blob read failed with HTTP ' + response.status);
        return response.text();
      });
      return;
    }
    return originalClick.apply(this, args);
  };
  return true;
`;

const readJsonAnchorHookScript = `
  const done = arguments[arguments.length - 1];
  const pending = window.__installedDesktopE2eExport;
  if (!pending) { done({ error: 'The application did not create an annotation JSON Blob.' }); return; }
  pending.then((text) => done({ text }), (error) => done({ error: String(error) }));
`;

const installBrowserDiagnosticsScript = `
  const errors = [];
  const originalConsoleError = console.error.bind(console);
  console.error = (...values) => {
    errors.push(values.map((value) => value instanceof Error ? value.message : String(value)).join(' '));
    originalConsoleError(...values);
  };
  window.addEventListener('error', (event) => errors.push(event.error?.message ?? event.message ?? 'window error'));
  window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.message ?? event.reason ?? 'unhandled rejection')));
  window.__installedDesktopE2eErrors = errors;
  return true;
`;

async function runScenario(scenario, fixture, index, total, apiBaseUrl) {
  await executeScript(installEmptyWorkspaceScript, [fixture]);
  await sessionCommand('POST', '/refresh', {}, 30_000);

  await waitForScript('the packaged demo page to render', `
    return document.querySelector('#ai-prompt')
      && document.querySelector('.document-page-image')
      && document.querySelector('.document-page-image').complete
      && document.querySelector('.document-page-image').naturalWidth > 0;
  `);
  await executeScript(installBrowserDiagnosticsScript);
  await executeScript(installJsonAnchorHookScript);

  assert.equal(await executeScript(`return document.querySelector('.agent-mode-grid button[aria-pressed="true"]')?.textContent.includes('Assist') ?? false;`), true, 'Assist mode must be selected.');
  assert.equal(await executeScript(`return document.querySelectorAll('.candidate-section .candidate-card').length;`), 0, 'The test workspace should start empty.');

  await executeScript(`
    const setValue = (selector, value) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing input ' + selector);
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
      descriptor.set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('#ai-prompt', 'Find torque limits and safety requirements on page 1. Ask me when the evidence is uncertain.');
    setValue('#annotation-guidelines', 'Use a concise label, quote the visible passage, and explain why it needs review.');
    document.querySelector('.task-plan-button')?.click();
    return true;
  `);
  await waitForScript('the visible local Annotation Task plan', `
    const card = document.querySelector('[aria-label="Annotation Task Plan"]');
    return card && card.innerText.includes('ローカル下書き') && card.innerText.includes('Annotation Task');
  `);
  const planText = await executeScript(`return document.querySelector('[aria-label="Annotation Task Plan"]').innerText;`);
  assert.ok(planText.includes('ローカル下書き'), 'Task planning should use the local planner.');

  await executeScript(`
    const button = document.querySelector('.page-run-button');
    if (!button || button.disabled || !button.textContent.includes('現在のページ（1）だけ実行')) {
      throw new Error('The page-one-only run control is missing or disabled.');
    }
    button.click();
    return true;
  `);
  await waitForScript('page-one candidates and a waiting human-review state', `
    const activity = document.querySelector('section[aria-label="Agent Activity"]');
    const status = activity?.querySelector('.agent-status-pill')?.textContent.trim();
    return status === 'Waiting' && document.querySelectorAll('.candidate-section .candidate-list .candidate-card').length === 2;
  `);

  const resourceUrls = await executeScript(`return performance.getEntriesByType('resource').map((entry) => entry.name);`);
  const scenarioRemoteUrls = resourceUrls.filter((url) => /^https?:\/\//i.test(url) && !url.startsWith(`${apiBaseUrl}/`));
  assert.deepEqual(scenarioRemoteUrls, [], `The ${scenario.action} run requested non-local HTTP resources.`);
  const scenarioAiRequests = resourceUrls.filter((url) => /\/api\/(?:ai|codex)\//i.test(url));
  assert.deepEqual(scenarioAiRequests, [], `The ${scenario.action} run attempted a provider endpoint.`);

  const activityText = await executeScript(`return document.querySelector('section[aria-label="Agent Activity"]').innerText;`);
  for (const phase of ['Planning', 'Navigating', 'Reading', 'Searching', 'Asking']) {
    assert.ok(activityText.includes(phase), `Visible Agent Activity is missing ${phase}.`);
  }
  assert.ok(await executeScript(`return document.querySelector('.candidate-section .demo-note')?.textContent.includes('デモ候補です。実モデルの解析結果ではありません。') ?? false;`), 'The app should disclose the deterministic demo candidates.');
  const activityRows = await executeScript(`return Array.from(document.querySelectorAll('section[aria-label="Agent Activity"] .agent-activity-list > li')).map((item) => item.innerText);`);
  const visitedPages = new Set(activityRows.flatMap((row) => [...row.matchAll(/P\.(\d+)/g)].map((match) => Number(match[1]))));
  assert.deepEqual([...visitedPages], [1], 'This run should visit only page 1.');

  const decision = await executeScript(`
    const scenario = arguments[0];
    const cards = Array.from(document.querySelectorAll('.candidate-section .candidate-card'));
    const card = cards.find((item) => item.querySelector('.candidate-label')?.textContent.trim() === scenario.candidate);
    if (!card) throw new Error('Review candidate was not found: ' + scenario.candidate);
    if (scenario.action === 'approve') {
      const button = Array.from(card.querySelectorAll('.candidate-actions .candidate-add')).find((item) => item.textContent.trim() === '確認して追加');
      if (!button) throw new Error('Approve control is missing.');
      button.click();
      return 'approved';
    }
    if (scenario.action === 'correct') {
      card.querySelector('details.candidate-correction-editor summary')?.click();
      const input = card.querySelector('details.candidate-correction-editor input');
      if (!input) throw new Error('Candidate correction label input is missing.');
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      descriptor.set.call(input, scenario.expectedLabel);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const button = Array.from(card.querySelectorAll('details.candidate-correction-editor button')).find((item) => item.textContent.trim() === '変更を反映して続行');
      if (!button) throw new Error('Candidate correction control is missing.');
      button.click();
      return 'corrected';
    }
    const rejectButton = Array.from(card.querySelectorAll('.candidate-actions .candidate-reject')).find((item) => item.textContent.trim() === '却下');
    if (!rejectButton) throw new Error('Reject control is missing.');
    rejectButton.click();
    return 'rejected';
  `, [scenario]);
  assert.equal(decision, scenario.action === 'approve' ? 'approved' : scenario.action === 'correct' ? 'corrected' : 'rejected');

  await waitForScript('the human review decision to update in the UI', `
    if (arguments[0] === 'approve') return Boolean(document.querySelector('.annotation-editor #annotation-label'));
    return document.querySelectorAll('.candidate-section .candidate-list .candidate-card').length === 1;
  `, [scenario.action]);

  const exportResult = await executeScript(`
    const button = Array.from(document.querySelectorAll('.export-popover button')).find((item) => item.textContent.trim() === '構造化JSONを保存');
    if (!button) throw new Error('The structured JSON export menu item is missing.');
    button.click();
    return true;
  `);
  assert.equal(exportResult, true);
  const captured = await executeAsyncScript(readJsonAnchorHookScript, [], 30_000);
  assert.ok(captured && captured.text, captured?.error ?? 'The JSON export Blob was not captured.');
  const exported = JSON.parse(captured.text);

  assert.equal(exported.document.fileName, fixture.fileName);
  assert.equal(exported.task.mode, 'assist');
  assert.ok(exported.task.plan?.title, 'The downloaded JSON should contain the visible Task plan.');
  assert.equal(exported.reviewQueue.length, 1, 'The other candidate should remain in the review queue.');
  assert.equal(exported.documentAnnotations.filter((record) => record.status === 'needs_review').length, 1);

  if (scenario.action === 'approve') {
    assert.equal(exported.annotations.length, 1);
    assert.equal(exported.annotations[0].label, scenario.expectedLabel);
    assert.equal(exported.annotations[0].source, 'ai');
    assert.equal(exported.annotations[0].reviewOutcome, 'approved');
    const approved = exported.documentAnnotations.find((record) => record.id === exported.annotations[0].id);
    assert.equal(approved.status, 'approved');
    assert.equal(exported.humanRejected.length, 0);
  } else if (scenario.action === 'correct') {
    assert.equal(exported.annotations.length, 1);
    assert.equal(exported.annotations[0].label, scenario.expectedLabel);
    assert.equal(exported.annotations[0].source, 'manual');
    assert.equal(exported.annotations[0].reviewOutcome, 'corrected');
    const corrected = exported.documentAnnotations.find((record) => record.id === exported.annotations[0].id);
    assert.equal(corrected.status, 'corrected');
    assert.equal(exported.humanRejected.length, 0);
  } else {
    assert.equal(exported.annotations.length, 0);
    assert.equal(exported.humanRejected.length, 1);
    assert.equal(exported.humanRejected[0].label, scenario.expectedLabel);
    const rejected = exported.documentAnnotations.find((record) => record.id === exported.humanRejected[0].id);
    assert.equal(rejected.status, 'rejected');
  }

  const browserErrors = await executeScript(`return window.__installedDesktopE2eErrors ?? [];`);
  assert.deepEqual(browserErrors, [], `The packaged renderer reported errors during the ${scenario.action} flow: ${browserErrors.join(' | ')}`);
  const finalResources = await executeScript(`return performance.getEntriesByType('resource').map((entry) => entry.name);`);
  const finalRemoteUrls = finalResources.filter((url) => /^https?:\/\//i.test(url) && !url.startsWith(`${apiBaseUrl}/`));
  assert.deepEqual(finalRemoteUrls, [], `The ${scenario.action} flow requested non-local HTTP resources.`);
  assert.deepEqual(finalResources.filter((url) => /\/api\/(?:ai|codex)\//i.test(url)), [], `The ${scenario.action} flow attempted a provider endpoint.`);

  console.log(`Packaged single-page ${scenario.action} flow ${index + 1}/${total} passed; JSON review statuses verified.`);
}

async function runPackageAcceptance() {
  await waitFor('tauri-driver readiness', async () => {
    try {
      const response = await fetch(`${driverBaseUrl}/status`, { signal: AbortSignal.timeout(750) });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload.value?.ready === true;
    } catch { return false; }
  });

  const created = await driverRequest('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'wry',
        'tauri:options': { application: appBinary },
      },
    },
  }, 120_000);
  sessionId = created.value?.sessionId ?? created.sessionId;
  assert.ok(sessionId, `tauri-driver did not create a W3C session: ${JSON.stringify(created)}`);
  appProcess = await waitFor('the test-owned installed Tauri process', findInstalledAppProcess, 15_000);
  await sessionCommand('POST', '/timeouts', { script: 30_000, pageLoad: 60_000, implicit: 0 });

  await waitForScript('the installed app UI', `
    return document.querySelector('h2')?.textContent.trim() === 'Visual Document Work Agent'
      && document.querySelector('#ai-prompt');
  `, [], 60_000);

  sidecarProcess = await waitFor('the bundled API sidecar process', findSidecarProcess, 15_000);
  apiPort = sidecarProcess.port;
  assert.equal(sidecarProcess.parentPid, appProcess.pid, 'The API sidecar must be the child of the installed Tauri app.');

  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const { response: healthResponse, payload: health } = await httpJson(`${apiBaseUrl}/api/health`);
  assert.equal(healthResponse.status, 200, 'The packaged sidecar health endpoint should return HTTP 200.');
  assert.equal(health.conversion, 'document-svg+raster-images', 'The sidecar did not serve the packaged API.');
  assert.equal(health.aiConfigured, false, 'The app must run without provider credentials.');
  assert.equal(health.codexAppServerConfigured, false, 'Codex App Server must be disabled for this test.');

  const { response: demoResponse, payload: demo } = await httpJson(`${apiBaseUrl}/api/demo`, 30_000);
  assert.equal(demoResponse.status, 200, 'The packaged API must serve its built-in fictional PDF.');
  assert.equal(demo.demo, true);
  assert.equal(demo.fileName, 'demo-specification.pdf');
  assert.ok(demo.pageCount >= 1);
  assert.match(demo.sourceHash, /^[\da-f]{64}$/i);

  const effectiveApiRequests = await executeScript(`
    return performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => url.includes('/api/'));
  `);
  assert.ok(effectiveApiRequests.some((url) => url === `${apiBaseUrl}/api/health`), 'The renderer did not use the sidecar URL discovered from its process.');
  assert.ok(effectiveApiRequests.some((url) => url === `${apiBaseUrl}/api/demo`), 'The renderer did not load the demo from the sidecar.');
  assert.equal(effectiveApiRequests.filter((url) => /\/api\/(?:ai|codex)\//i.test(url)).length, 0, 'The packaged browser attempted a provider endpoint.');
  const allResourceUrls = await executeScript(`return performance.getEntriesByType('resource').map((entry) => entry.name);`);
  const nonLocalHttpResources = allResourceUrls.filter((url) => /^https?:\/\//i.test(url) && !url.startsWith(`${apiBaseUrl}/`));
  assert.deepEqual(nonLocalHttpResources, [], `The packaged browser requested non-local HTTP resources: ${nonLocalHttpResources.join(', ')}`);

  const fixture = createWorkspaceFixture(demo);
  const scenarios = [
    { action: 'approve', candidate: '制限値', expectedLabel: '制限値' },
    { action: 'correct', candidate: '安全上の注意', expectedLabel: '人が修正した安全基準' },
    { action: 'reject', candidate: '制限値', expectedLabel: '制限値' },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await runScenario(scenario, fixture, index, scenarios.length, apiBaseUrl);
  }

  const beforeCloseHealth = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
  assert.equal(beforeCloseHealth.status, 200, 'The bundled API should still be healthy before normal app close.');
  let closeWindowError;
  try {
    await sessionCommand('DELETE', '/window', undefined, 15_000);
  } catch (error) {
    closeWindowError = error;
  }

  const shutdownDeadline = Date.now() + 20_000;
  let shutdownVerified = false;
  while (Date.now() < shutdownDeadline) {
    const appAlive = await processStillMatches(appProcess.pid, { kind: 'app' });
    const sidecarAlive = await processStillMatches(sidecarProcess.pid, sidecarProcess);
    const refused = await checkPortRefused(apiPort);
    if (!appAlive && !sidecarAlive && refused) {
      shutdownVerified = true;
      break;
    }
    await sleep(250);
  }
  assert.ok(shutdownVerified, `Closing the installed app did not stop app PID ${appProcess.pid}, sidecar PID ${sidecarProcess.pid}, and port ${apiPort}.${closeWindowError ? ` WebDriver close returned: ${String(closeWindowError)}` : ''}`);
  sessionClosedNormally = true;
  console.log(`Installed app ${appProcess.pid} exited normally; bundled API sidecar ${sidecarProcess.pid} exited and port ${apiPort} refused connections.${closeWindowError ? ' The close-window response was lost after the app exited.' : ''}`);
}

async function terminateProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(3_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function terminateKnownAppProcesses() {
  if (sessionClosedNormally) return;
  appProcess ??= await findInstalledAppProcess();
  sidecarProcess ??= await findSidecarProcess();
  for (const [pid, expected] of [
    appProcess ? [appProcess.pid, { kind: 'app' }] : null,
    sidecarProcess ? [sidecarProcess.pid, sidecarProcess] : null,
  ].filter(Boolean)) {
    if (await processStillMatches(pid, expected)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* The process may have exited between the check and signal. */ }
    }
  }
  await sleep(500);
  for (const [pid, expected] of [
    appProcess ? [appProcess.pid, { kind: 'app' }] : null,
    sidecarProcess ? [sidecarProcess.pid, sidecarProcess] : null,
  ].filter(Boolean)) {
    if (await processStillMatches(pid, expected)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The process may have exited between the check and signal. */ }
    }
  }
}

try {
  await access(debPath);
  for (const directory of Object.values(runtimeDirectories)) await mkdir(directory, { recursive: true });
  await runPackageAcceptance();
  assert.equal(sessionClosedNormally, true, 'The app and sidecar did not complete the normal shutdown path.');
  console.log('Installed .deb Tauri/WebDriver acceptance passed with no provider configured.');
} finally {
  appProcess ??= await findInstalledAppProcess();
  sidecarProcess ??= await findSidecarProcess();
  if (sessionId) {
    await driverRequest('DELETE', `/session/${sessionId}`, undefined, 10_000).catch(() => {});
  }
  await terminateProcess(driver);
  await terminateKnownAppProcesses();
  await rm(tempRoot, { recursive: true, force: true });
}
