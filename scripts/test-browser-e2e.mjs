import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliSession = `visual-document-e2e-${process.pid}-${Date.now()}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'visual-document-work-agent-e2e-'));
const apiDataDirectory = join(temporaryDirectory, 'api-state');
const cliArtifactDirectory = join(temporaryDirectory, 'browser-cli');
const cliScript = resolve(root, 'node_modules/@playwright/cli/playwright-cli.js');
const children = [];

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

async function waitForResponse(url, child, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) {
      throw new Error(`${child.name} exited before readiness (${child.child.exitCode}).\n${child.output}`);
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
  throw new Error(`${child.name} did not become ready at ${url}: ${lastError}.\n${child.output}`);
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

let cliOpened = false;
try {
  const apiPort = await availablePort();
  let webPort = await availablePort();
  while (webPort === apiPort) webPort = await availablePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const appUrl = `http://127.0.0.1:${webPort}`;

  const api = spawnCaptured('local API', ['--import', 'tsx', 'server/index.ts'], {
    HOST: '127.0.0.1',
    PORT: String(apiPort),
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
    ANNOTATION_STUDIO_DATA_DIR: apiDataDirectory,
    NODE_ENV: 'test',
  });
  const healthResponse = await waitForResponse(`${apiUrl}/api/health`, api, async (response) => response.ok);
  const health = await healthResponse.json();
  assert.equal(health.aiConfigured, false, 'The E2E API must start without any configured provider credentials.');
  assert.equal(health.codexAppServerConfigured, false, 'The E2E API must not use a Codex provider.');

  const web = spawnCaptured('Vite web server', [
    'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], {
    ANNOTATION_STUDIO_API_TARGET: apiUrl,
  });
  await waitForResponse(appUrl, web, async (response) => response.ok);

  await rm(cliArtifactDirectory, { recursive: true, force: true });
  await mkdir(cliArtifactDirectory, { recursive: true });
  await runCli('open', 'about:blank');
  cliOpened = true;
  await runCli('goto', `${appUrl}/api/demo`);
  const flowPath = resolve(root, 'scripts/browser-e2e/visual-document-review.js');
  const result = await runCli('run-code', '--filename', flowPath);
  assert.match(result, /approve, correct, and reject/i, 'The browser flow did not report all human review paths.');

  console.log('Provider-free browser E2E passed: demo PDF planning/activity, single-page candidate review, approve/change/reject, JSON export, and no browser console errors.');
} finally {
  if (cliOpened) {
    await runCli('close').catch(() => {});
  }
  await runCli('delete-data').catch(() => {});
  await Promise.all(children.reverse().map(stopChild));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
