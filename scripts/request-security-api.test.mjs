import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

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

test('API rejects DNS-rebinding Host/Origin pairs while preserving explicit and local origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-request-security-'));
  const port = await availablePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
      CODEX_APP_SERVER_DISABLED: 'true', MAX_UPLOAD_MB: 'invalid',
      CORS_ALLOWED_ORIGINS: 'https://trusted.example',
      ANNOTATION_STUDIO_DATA_DIR: join(directory, 'api-state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API exited before readiness (${child.exitCode}).\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(800) });
        if (response.ok) { ready = true; break; }
      } catch { /* Retry during API startup. */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(ready, true, `API did not become ready.\n${output}`);

    const attackerOrigin = `http://attacker.example:${port}`;
    const rebound = await fetch(`${baseUrl}/api/health`, { headers: { Origin: attackerOrigin, Host: `attacker.example:${port}` } });
    assert.equal(rebound.status, 403, 'a matching attacker Host/Origin pair bypassed the loopback CORS guard');
    assert.equal(rebound.headers.get('access-control-allow-origin'), null, 'the rejected attacker origin was reflected');

    const localOrigin = `http://127.0.0.1:${port}`;
    const local = await fetch(`${baseUrl}/api/health`, { headers: { Origin: localOrigin, Host: `127.0.0.1:${port}` } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('access-control-allow-origin'), localOrigin);

    const configured = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://trusted.example' } });
    assert.equal(configured.status, 200);
    assert.equal(configured.headers.get('access-control-allow-origin'), 'https://trusted.example');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
