import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeDirectory = resolve(process.argv[2] ?? join(root, 'src-tauri/resources/desktop-runtime'));
const manifest = JSON.parse(await readFile(join(runtimeDirectory, 'runtime-manifest.json'), 'utf8'));
const hostTriple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();

if (manifest.targetTriple !== hostTriple) {
  console.log(`Skipping desktop runtime execution check for cross-target ${manifest.targetTriple} on ${hostTriple}.`);
  process.exit(0);
}

const node = join(runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const token = `lifetime-${process.pid}-${Date.now()}`;
const dataDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-runtime-test-'));
const probe = createServer();
await new Promise((resolveReady, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolveReady));
const port = probe.address().port;
await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));

let child;
let stdout = '';
let stderr = '';

async function isHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.json()).conversion === 'document-svg+raster-images';
  } catch {
    return false;
  }
}

async function waitForExit(timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bundled API did not exit after its stdin lifetime pipe closed.')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

try {
  child = spawn(node, ['--import', 'tsx', 'desktop-api-launcher.mjs'], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      ANNOTATION_STUDIO_API_ONLY: 'true',
      ANNOTATION_STUDIO_STARTUP_TOKEN: token,
      ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8').on('data', (value) => { stdout = `${stdout}${value}`.slice(-16 * 1024); });
  child.stderr.setEncoding('utf8').on('data', (value) => { stderr = `${stderr}${value}`.slice(-16 * 1024); });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bundled API exited before readiness (${child.exitCode}). ${stderr}`);
    if (stdout.includes(`ANNOTATION_STUDIO_READY:${token}`) && await isHealthy()) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(stdout.includes(`ANNOTATION_STUDIO_READY:${token}`), `Bundled API did not emit its startup handshake. ${stderr}`);
  assert.equal(await isHealthy(), true, `Bundled API did not pass its health check. ${stderr}`);

  child.stdin.end();
  const exit = await waitForExit(5_000);
  assert.equal(exit.code, 0, `Bundled API did not exit cleanly after its parent pipe closed (${exit.signal ?? 'no signal'}). ${stderr}`);
  assert.equal(await isHealthy(), false, 'Bundled API still responds after its parent lifetime pipe closed.');
  console.log(`Bundled ${manifest.targetTriple} API readiness and parent-pipe shutdown passed.`);
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end();
    child.kill();
    await waitForExit(2_000).catch(() => {});
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
