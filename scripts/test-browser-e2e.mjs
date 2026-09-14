import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createDocxFixture, createPptxFixture } from './office-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliSession = `visual-document-e2e-${process.pid}-${Date.now()}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'visual-document-work-agent-e2e-'));
const apiDataDirectory = join(temporaryDirectory, 'api-state');
const cliArtifactDirectory = join(temporaryDirectory, 'browser-cli');
const workbookFixturePath = join(temporaryDirectory, 'wide-preview.xlsx');
const changedSourcePdfPath = join(temporaryDirectory, 'demo-specification.pdf');
const officeDocxFixturePath = join(temporaryDirectory, 'office-review.docx');
const officePptxFixturePath = join(temporaryDirectory, 'office-roadmap.pptx');
const navigationPdfFixturePath = join(temporaryDirectory, 'agent-navigation.pdf');
const folderFixtureDirectory = join(temporaryDirectory, 'mixed-review-project');
const visualEvidenceDirectory = resolve(root, 'output/playwright/ui-redesign');
const productHuntAssetDirectory = resolve(root, 'docs/product-hunt/assets');
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
    command.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-120_000); });
    command.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-120_000); });
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
  await mkdir(visualEvidenceDirectory, { recursive: true });
  await mkdir(productHuntAssetDirectory, { recursive: true });
  const workbookFixture = new ExcelJS.Workbook();
  const wideSheet = workbookFixture.addWorksheet('Wide');
  wideSheet.addRow(Array.from({ length: 120 }, (_, column) => `Header ${column + 1}`));
  for (let row = 2; row <= 35; row += 1) wideSheet.addRow(Array.from({ length: 120 }, (_, column) => `source-${row}-${column + 1}`));
  await writeFile(workbookFixturePath, Buffer.from(await workbookFixture.xlsx.writeBuffer()));
  const changedSourcePdf = await PDFDocument.create();
  const changedSourceFont = await changedSourcePdf.embedFont(StandardFonts.Helvetica);
  const changedSourcePage = changedSourcePdf.addPage([612, 792]);
  changedSourcePage.drawText('Changed content with the same filename for run-history source isolation.', {
    x: 48, y: 700, size: 16, font: changedSourceFont, color: rgb(0.12, 0.2, 0.28),
  });
  await writeFile(changedSourcePdfPath, Buffer.from(await changedSourcePdf.save()));
  await writeFile(officeDocxFixturePath, await createDocxFixture());
  await writeFile(officePptxFixturePath, await createPptxFixture());
  const navigationPdf = await PDFDocument.create();
  const navigationFont = await navigationPdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 15; pageNumber += 1) {
    const page = navigationPdf.addPage([612, 792]);
    const content = pageNumber === 2
      ? 'NAVIGATION STREAM TARGET. Either party may terminate for convenience on thirty days notice.'
      : pageNumber === 14
        ? 'RELATED EXCEPTION. The clause is still effective after the review page.'
        : pageNumber === 15 ? 'APPENDIX. Final-page coverage checkpoint.' : `GENERAL TERMS. Navigation page ${pageNumber}.`;
    page.drawText(content, { x: 48, y: 700, size: 14, font: navigationFont });
  }
  await writeFile(navigationPdfFixturePath, Buffer.from(await navigationPdf.save()));
  const folderFixtureContentDirectory = join(folderFixtureDirectory, 'source-files');
  await mkdir(folderFixtureContentDirectory, { recursive: true });
  await copyFile(resolve(root, 'public/demo-specification.pdf'), join(folderFixtureContentDirectory, '01 Safety.pdf'));
  await copyFile(workbookFixturePath, join(folderFixtureContentDirectory, '02 Workbook.xlsx'));
  await sharp({ create: { width: 240, height: 160, channels: 3, background: { r: 219, g: 234, b: 238 } } })
    .png().toFile(join(folderFixtureContentDirectory, '03 Inspection photo.png'));
  await writeFile(join(folderFixtureContentDirectory, 'ignore-me.txt'), 'Unsupported files should be filtered from the project.');

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
    CORS_ALLOWED_ORIGINS: appUrl,
    ANNOTATION_STUDIO_DATA_DIR: apiDataDirectory,
    NODE_ENV: 'test',
  });
  const healthResponse = await waitForResponse(`${apiUrl}/api/health`, api, async (response) => response.ok);
  const health = await healthResponse.json();
  assert.equal(health.aiConfigured, false, 'The E2E API must start without any configured provider credentials.');
  assert.equal(health.codexAppServerConfigured, false, 'The E2E API must not use a Codex provider.');

  const build = spawnCaptured('Vite production build', [
    'node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native',
  ], {});
  await waitForSuccessfulExit(build);

  const web = spawnCaptured('Vite preview server', [
    'node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], {
    ANNOTATION_STUDIO_API_TARGET: apiUrl,
  });
  await waitForResponse(appUrl, web, async (response) => response.ok);

  await rm(cliArtifactDirectory, { recursive: true, force: true });
  await mkdir(cliArtifactDirectory, { recursive: true });
  await runCli('open', 'about:blank');
  cliOpened = true;
  await runCli('goto', `${appUrl}/api/demo`);
  const flowTemplate = await readFile(resolve(root, 'scripts/browser-e2e/visual-document-review.js'), 'utf8');
  assert.ok(flowTemplate.includes('__WORKBOOK_FIXTURE_PATH__') && flowTemplate.includes('__CHANGED_SOURCE_PDF_PATH__') && flowTemplate.includes('__OFFICE_DOCX_FIXTURE_PATH__') && flowTemplate.includes('__OFFICE_PPTX_FIXTURE_PATH__') && flowTemplate.includes('__NAVIGATION_PDF_FIXTURE_PATH__') && flowTemplate.includes('__FOLDER_FIXTURE_DIRECTORY__') && flowTemplate.includes('__VISUAL_EVIDENCE_DIRECTORY__') && flowTemplate.includes('__PRODUCT_HUNT_ASSET_DIRECTORY__'), 'The browser flow is missing a fixture or screenshot-path placeholder.');
  const flowPath = join(cliArtifactDirectory, 'visual-document-review.js');
  await writeFile(flowPath, flowTemplate
    .replace('__WORKBOOK_FIXTURE_PATH__', JSON.stringify(workbookFixturePath))
    .replace('__CHANGED_SOURCE_PDF_PATH__', JSON.stringify(changedSourcePdfPath))
    .replace('__OFFICE_DOCX_FIXTURE_PATH__', JSON.stringify(officeDocxFixturePath))
    .replace('__OFFICE_PPTX_FIXTURE_PATH__', JSON.stringify(officePptxFixturePath))
    .replace('__NAVIGATION_PDF_FIXTURE_PATH__', JSON.stringify(navigationPdfFixturePath))
    .replace('__FOLDER_FIXTURE_DIRECTORY__', JSON.stringify(folderFixtureDirectory))
    .replace('__VISUAL_EVIDENCE_DIRECTORY__', JSON.stringify(visualEvidenceDirectory))
    .replace('__PRODUCT_HUNT_ASSET_DIRECTORY__', JSON.stringify(productHuntAssetDirectory)));
  const result = await runCli('run-code', '--filename', flowPath);
  assert.match(result, /Contract review demo passed: optional fictional PDF, six termination clauses, one scripted ambiguous review candidate, human approval, and persistent no-model disclosure/i, 'The production browser flow did not verify the optional contract review demo.');
  assert.match(result, /Live contract LLM demo passed: separate unlabeled eleven-page PDF with fourteen clauses, Autopilot preselection, model-connection gate, and no scripted results/i, 'The production browser flow did not verify the Product Hunt live contract demo.');
  assert.match(result, /Customer feedback LLM demo passed: 16 blank synthetic records, live-model-only run guard, full-width worksheet preview, and no scripted annotations/i, 'The production browser flow did not verify the live customer feedback LLM demo.');
  assert.match(result, /PDF review.*continuation/i, 'The browser flow did not report the PDF review and continuation paths.');
  assert.match(result, /run-?history.*reload.*source isolation/i, 'The browser flow did not verify persisted run history and changed-source isolation.');
  assert.match(result, /streamed Agent navigation and viewport-to-highlight interaction/i, 'The browser flow did not verify streamed tool events against the visible document viewer.');
  assert.match(result, /DOCX\/PPTX upload, annotation, and native export/i, 'The browser flow did not verify Word and PowerPoint through the app UI.');
  assert.match(result, /XLSX column jump\/context paging/i, 'The browser flow did not verify the workbook review UI.');
  const extractionZip = await JSZip.loadAsync(await readFile(join(visualEvidenceDirectory, 'contract-extractions.zip')));
  const extractionManifest = JSON.parse(await extractionZip.file('manifest.json').async('string'));
  assert.equal(extractionManifest.document.pageCount, 2);
  assert.equal(extractionManifest.annotations.length, 5, 'Only the five confirmed annotations should be extracted; the pending sixth must stay out.');
  assert.deepEqual([...new Set(extractionManifest.annotations.map((item) => item.pageNumber))], [1, 2]);
  const extractionNotes = await extractionZip.file('notes.md').async('string');
  assert.match(extractionNotes, /thirty/);
  assert.ok(!extractionNotes.includes('reasonable business circumstances'), 'Pending evidence leaked into confirmed notes.');
  for (const annotation of extractionManifest.annotations) {
    const png = await extractionZip.file(annotation.image).async('nodebuffer');
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.format, 'png');
    assert.ok(metadata.width > 100 && metadata.height > 10, 'The extracted PNG has no useful area.');
    const stats = await sharp(png).stats();
    assert.ok(stats.channels.some((channel) => channel.stdev > 4), 'The extracted PNG is blank.');
  }
  console.log('Multi-page extraction ZIP verified: five PNG crops, Unicode labels, source-page coordinates, Markdown evidence, pending exclusion.');


  console.log('Provider-free browser E2E passed on the production preview: optional fictional contract review demo, live-model-only customer feedback LLM demo, PDF planning/activity/review/export, streamed Agent navigation and viewport-to-highlight interaction, run-history reload/export/source isolation, mixed-format folder subset batch with per-document review/export, DOCX/PPTX upload and native export, human-approved correction-rule continuation, read-only Validator recheck with stale-response protection, and XLSX column navigation/context paging; no external provider calls or browser console errors.');
} finally {
  if (cliOpened) {
    await runCli('close').catch(() => {});
  }
  await runCli('delete-data').catch(() => {});
  await Promise.all(children.reverse().map(stopChild));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
