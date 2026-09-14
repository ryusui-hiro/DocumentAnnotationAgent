import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';
import { createDocxFixture, createPptxFixture } from './office-fixtures.mjs';

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
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
      AZURE_OPENAI_DEPLOYMENT_GPT6: '', AZURE_OPENAI_DEPLOYMENT_GPT56_SOL: '',
      AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA: '', AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA: '',
      CODEX_APP_SERVER_DISABLED: 'true', ANNOTATION_STUDIO_DATA_DIR: dataDirectory,
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
  if (api.child.exitCode !== null || api.child.signalCode !== null) return;
  api.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => api.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL');
}

test('the document API converts DOCX and PPTX uploads and returns annotation-bearing Office packages', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-office-export-api-'));
  const apiPort = await availablePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const api = startApiServer(apiPort, dataDirectory);
  try {
    await waitForApi(apiUrl, api);
    for (const [fileName, mimeType, source, target] of [
      ['review.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await createDocxFixture(), { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.75, height: 0.08 } }],
      ['roadmap.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', await createPptxFixture(), { kind: 'slide', slide: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.25 } }],
    ]) {
      const sourceCopy = Buffer.from(source);
      const form = new FormData();
      form.append('file', new Blob([source], { type: mimeType }), fileName);
      const upload = await fetch(`${apiUrl}/api/convert`, { method: 'POST', body: form });
      const uploadText = await upload.text();
      assert.equal(upload.status, 200, `${fileName} upload failed: ${uploadText}`);
      const document = JSON.parse(uploadText);
      assert.equal(document.fileName, fileName);
      assert.equal(document.pageCount, 1);
      assert.equal(document.fileType.toLowerCase(), fileName.split('.').at(-1));
      assert.match(document.sourceHash, /^[\da-f]{64}$/i);

      const annotation = {
        id: `api-${fileName.replace(/\W+/g, '-')}`, documentId: document.documentId, sourceHash: document.sourceHash,
        target, label: fileName.endsWith('.docx') ? 'HIGH RISK' : 'PRODUCT',
        evidence: fileName.endsWith('.docx') ? 'Either party may terminate without cause.' : 'Confidential product roadmap',
        explanation: 'The exact visible excerpt supports this classification.',
        reviewPriority: 'medium', status: 'approved', note: 'Confirmed during Office API E2E.',
        reason: 'The selected Office content is the export anchor.',
        excerpt: fileName.endsWith('.docx') ? 'Either party may terminate without cause.' : 'Confidential product roadmap',
        color: '#178b87', source: 'ai', requiresReview: false, reviewedByHuman: true,
      };
      const exportResponse = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(document.documentId)}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'native-annotated', documentAnnotations: [annotation] }),
      });
      const exportedBytes = Buffer.from(await exportResponse.arrayBuffer());
      assert.equal(exportResponse.status, 200, `${fileName} native export failed: ${exportedBytes.toString('utf8').slice(0, 500)}`);
      assert.match(exportResponse.headers.get('content-type') ?? '', /officedocument/);
      assert.deepEqual(source, sourceCopy, `${fileName} upload/export mutated the source buffer`);
      const packageZip = await JSZip.loadAsync(exportedBytes);
      if (fileName.endsWith('.docx')) {
        assert.ok(packageZip.file('word/comments.xml'), 'DOCX export omitted its native Word comments part');
        const comments = await packageZip.file('word/comments.xml').async('string');
        assert.match(comments, /HIGH RISK/);
        assert.match(comments, /Either party may terminate without cause/);
        const documentXml = await packageZip.file('word/document.xml').async('string');
        assert.match(documentXml, /commentRangeStart/);
        assert.match(documentXml, /commentReference/);
      } else {
        assert.ok(packageZip.file('ppt/tags/annotation-studio-tags1.xml'), 'PPTX export omitted its semantic annotation tags part');
        const slideXml = await packageZip.file('ppt/slides/slide1.xml').async('string');
        assert.match(slideXml, /PRODUCT/);
        const relationships = await packageZip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
        assert.match(relationships, /tags/);
      }
    }
  } finally {
    await stopApi(api);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
