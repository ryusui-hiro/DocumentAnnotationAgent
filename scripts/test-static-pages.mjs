import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString, StandardFonts, degrees, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createDocxFixture, createPptxFixture } from './office-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const builtDirectory = resolve(process.argv[2] ?? join(root, 'dist-pages'));
const base = '/DocumentAnnotationAgent/';
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-static-pages-e2e-'));
const evidenceDirectory = join(root, 'output/playwright/static-pages');
const session = `static-pages-${process.pid}-${Date.now()}`;
const cliPath = join(root, 'node_modules/@playwright/cli/playwright-cli.js');
const serverRequests = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  serverRequests.push({ pathname, method: request.method, authorization: request.headers.authorization });
  try {
    if (request.method !== 'GET' || !pathname.startsWith(base)) { response.writeHead(404); response.end('Static assets only'); return; }
    const relative = decodeURIComponent(pathname.slice(base.length)) || 'index.html';
    const path = resolve(builtDirectory, relative);
    if (!path.startsWith(`${builtDirectory}${sep}`) || !(await stat(path)).isFile()) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end('Not found'); }
});

function runCli(...args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [cliPath, '--session', session, ...args], { cwd: temporaryDirectory, env: { ...process.env, PLAYWRIGHT_CLI_SESSION: session }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-100_000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-100_000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveCommand(output) : reject(new Error(`Static browser ${args[0]} failed (${code}).\n${output}`)));
  });
}

async function browserFlow(page) {
  const config = __STATIC_CONFIG__;
  const check = (value, message) => { if (!value) throw new Error(`Static Pages E2E: ${message}`); };
  const browserErrors = [];
  const unexpectedRequests = [];
  const observed = [];
  const providerRequests = [];
  const downloads = {};
  let active = 0, maxActive = 0, models = 0;
  let releaseResponses, signalThree;
  const responseGate = new Promise(resolve => { releaseResponses = resolve; });
  const threeStarted = new Promise(resolve => { signalThree = resolve; });
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('request', request => observed.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  const cors = { 'access-control-allow-origin': config.origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': '*' };
  const sse = (number) => {
    const block = { type: 'region', label: 'Required label', note: `Checked API fixture ${number}.`, bbox: { x: .15, y: .15, width: .3, height: .12 }, extractedText: 'Visible fixture evidence', latex: null, uncertain: false, uncertaintyReason: '' };
    const text = JSON.stringify({ blocks: [block], warnings: [] });
    const response = { id: `resp_pages_${number}`, object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'in_progress', output: [] };
    const message = { id: `msg_pages_${number}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const finalMessage = { ...message, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    return [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: message },
      { type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: text, logprobs: [] },
      { type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text, logprobs: [] },
      { type: 'response.output_item.done', output_index: 0, item: finalMessage },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [finalMessage], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } } },
    ].map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
  };
  await page.route('**/*', async route => {
    const request = route.request(); const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    if (url.startsWith(config.api)) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*' } });
      check(request.headers().authorization === `Bearer ${config.key}`, 'the configured user key must be sent in the provider authorization header');
      if (url === `${config.api}/models` && request.method() === 'GET') { models++; return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'gpt-6-astra', object: 'model', created: 1, owned_by: 'test' }] }) }); }
      if (url === `${config.api}/responses` && request.method() === 'POST') {
        const body = request.postDataJSON();
        check(body.stream === true && body.store === false, 'Responses must stream without provider storage');
        check(body.instructions.includes('Required label') && body.instructions.includes('Visible fixture evidence only'), 'binding label name and definition were not sent');
        check(JSON.stringify(body.text?.format?.schema).includes('Required label'), 'the structured output schema must constrain the label');
        check(body.input?.[0]?.content?.[0]?.image_url?.startsWith('data:image/png;base64,'), 'the model must receive the locally rendered page');
        check(!JSON.stringify(body).includes(config.key), 'the user key leaked into the model body');
        providerRequests.push({ model: body.model, imageLength: body.input[0].content[0].image_url.length });
        const number = providerRequests.length;
        active++; maxActive = Math.max(maxActive, active); if (active === 3) signalThree();
        await responseGate;
        await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: sse(number) });
        active--; return;
      }
    }
    if (url.startsWith(config.origin)) {
      if (!url.startsWith(config.appUrl) || /\/api\//.test(url.slice(config.origin.length))) { unexpectedRequests.push(url); return route.abort(); }
      check(!Object.values(request.headers()).some(value => value.includes(config.key)), 'the API key was sent to the static host');
      return route.continue();
    }
    unexpectedRequests.push(url); return route.abort();
  });
  const ready = async (name) => {
    await page.locator('.ocr-documents h1').filter({ hasText: name }).waitFor();
    await page.waitForFunction(name => { const image = document.querySelector('.ocr-page > img'); return image?.alt.startsWith(name) && image.complete && image.naturalWidth > 0; }, name, { timeout: 45000 });
  };
  const open = async (path, name) => { await page.getByTestId('document-file-input').setInputFiles(path); await ready(name); };
  const download = async (menu, filename) => {
    await page.locator('.ocr-export-wrap > button').click();
    const event = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: menu, exact: true }).click();
    const file = await event;
    await file.saveAs(`${config.evidence}/${filename}`);
    downloads[filename] = file.suggestedFilename();
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(config.appUrl);
    await page.getByRole('heading', { name: 'Your documents. Your direction.', exact: true }).waitFor();
    await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('.ocr-welcome img')?.complete && document.querySelector('.ocr-welcome img')?.naturalWidth > 0);
    check(await page.locator('.ocr-page, .ocr-results article').count() === 0, 'a new tab must start blank');
    check(await page.getByRole('link', { name: 'View source on GitHub' }).getAttribute('href') === 'https://github.com/ryusui-hiro/DocumentAnnotationAgent', 'the GitHub source link is missing or incorrect');
    await page.screenshot({ path: `${config.evidence}/welcome-1440x900.png` });
    await page.getByRole('button', { name: 'Explore a paper', exact: true }).click();
    await ready('openai-paper-selected.pdf');
    check(await page.locator('.ocr-thumbnail').count() === 3, 'the published paper demo must show its three pages');
    check(await page.locator('.ocr-result').count() > 0, 'the paper demo is missing its published annotations');
    await page.reload();
    await page.getByRole('heading', { name: 'Your documents. Your direction.' }).waitFor();

    await open(config.pdf, 'pages-static-contract.pdf');
    check(await page.locator('.ocr-thumbnail').count() === 3, 'local PDF import lost pages');
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    const box = await page.locator('.ocr-page').boundingBox(); check(box, 'the page is not visible');
    await page.mouse.move(box.x + box.width * .12, box.y + box.height * .18); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .42, box.y + box.height * .38, { steps: 12 }); await page.mouse.up();
    await page.getByRole('textbox', { name: 'Annotation label', exact: true }).fill('Manual check');
    await page.getByRole('textbox', { name: 'Annotation note', exact: true }).fill('Native PDF comment from the static website.');
    check(await page.locator('.ocr-result-origin').innerText() === 'Manual', 'manual annotation origin was not retained');
    await download('JSON', 'manual.json');
    await download('Annotated PDF', 'manual-annotated.pdf');

    await open(config.image, 'static-image.png');
    check(await page.locator('.ocr-thumbnail').count() === 1, 'image import should produce one page');
    for (const office of config.office) {
      await open(office.path, office.name);
      if (await page.locator('.ocr-preview-warnings').getAttribute('open') === null) await page.locator('.ocr-preview-warnings > summary').click();
      check((await page.locator('.ocr-preview-warnings').innerText()).includes('Original pagination'), `${office.name} must disclose Office reflow`);
      check((await page.locator('.ocr-preview-warnings').innerText()).includes('not preserved'), `${office.name} must disclose fidelity limits`);
    }
    await page.locator('.ocr-file-list button').filter({ hasText: 'pages-static-contract.pdf' }).click(); await ready('pages-static-contract.pdf');
    check(await page.locator('.ocr-result').count() === 1, 'switching documents lost the manual annotation');
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    check(await settings.locator('#api-server-url').inputValue() === '', 'a document backend must not be configured for this test');
    await settings.locator('#provider-mode').selectOption('openai-api');
    await settings.locator('#ai-endpoint').fill(config.api);
    await settings.locator('#api-key').fill(config.key);
    await settings.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page.locator('.connection-test-result.is-success').waitFor();
    check(models === 1 && providerRequests.length === 0, 'connection testing must only read model metadata');
    await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('#ocr-instruction').fill('Mark each visible evidence passage using Required label.');
    await page.locator('.ocr-label-rules > summary').click();
    await page.getByRole('button', { name: '+ Add label', exact: true }).click();
    await page.getByTestId('label-rule-name').fill('Required label');
    await page.getByTestId('label-rule-definition').fill('Visible fixture evidence only');
    await page.getByTestId('run-document').click();
    await Promise.race([threeStarted, page.waitForTimeout(20000).then(() => { throw new Error('Three provider requests did not start concurrently.'); })]);
    check(maxActive === 3, 'the document should use three parallel page workers');
    check((await page.locator('.ocr-parallel-status').innerText()).includes('3 pages processing'), 'the UI must show three active pages');
    releaseResponses();
    await page.locator('.ocr-parallel-status').filter({ hasText: 'Run complete' }).waitFor({ timeout: 45000 });
    check((await page.locator('.ocr-parallel-status').innerText()).includes('3/3 complete · 0 failed'), 'all three streamed pages must complete');
    check(providerRequests.length === 3, 'each page must make one Responses request');
    check(await page.locator('.ocr-result').count() === 2, 'AI results must preserve the manual annotation');
    check((await page.locator('.ocr-results').innerText()).includes('Required label'), 'the bound AI label is not visible');
    check(await page.locator('.ocr-result.is-provisional').count() === 0, 'successful final responses must replace provisional results');
    await download('JSON', 'completed.json');
    const geometry = await page.evaluate(() => ({ innerWidth, width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, root: document.querySelector('#root').getBoundingClientRect().width, shell: document.querySelector('.ocr-shell').getBoundingClientRect().width }));
    check(geometry.width === 1440 && geometry.scrollWidth <= 1440 && Math.abs(geometry.root - 1440) <= 1 && Math.abs(geometry.shell - 1440) <= 1, `the app must fill the viewport without overflow: ${JSON.stringify(geometry)}`);
    await page.locator('.ocr-label-rules > summary').click();
    await page.screenshot({ path: `${config.evidence}/completed-1440x900.png` });
    const storage = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    check(!JSON.stringify(storage).includes(config.key), 'the user API key must not be persisted');
    check(observed.filter(item => Object.values(item.headers).some(value => value.includes(config.key))).every(item => item.url === `${config.api}/models` || item.url === `${config.api}/responses`), 'the key was sent outside the selected API endpoints');
    check(unexpectedRequests.length === 0, `unexpected network request: ${unexpectedRequests.join(', ')}`);
    check(browserErrors.length === 0, `browser errors: ${browserErrors.join(' | ')}`);
    await page.reload();
    await page.getByRole('heading', { name: 'Your documents. Your direction.' }).waitFor();
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
    check(await page.locator('#api-key').inputValue() === '', 'reloading must clear the session key');
    return { success: true, maxActive, providerRequests: providerRequests.length, models, downloads, geometry, browserErrors, unexpectedRequests };
  } finally { releaseResponses(); }
}

let opened = false;
try {
  await readFile(join(builtDirectory, 'index.html'));
  await mkdir(evidenceDirectory, { recursive: true });
  const pdfPath = join(temporaryDirectory, 'pages-static-contract.pdf');
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
    const page = pdf.addPage([600, 800]);
    if (pageNumber === 1) { page.setCropBox(30, 50, 520, 650); page.setRotation(degrees(90)); }
    page.drawRectangle({ x: 60, y: 80, width: 180, height: 160, color: rgb(.89, .95, .93) });
    page.drawText(`PAGE ${pageNumber}: Visible fixture evidence`, { x: 65, y: 350, size: 18, font });
    page.drawText('A genuine PDF text layer remains in native exports.', { x: 65, y: 320, size: 13, font });
  }
  await writeFile(pdfPath, await pdf.save());
  const imagePath = join(temporaryDirectory, 'static-image.png');
  await sharp({ create: { width: 480, height: 320, channels: 3, background: '#71b2a1' } }).png().toFile(imagePath);
  const docxPath = join(temporaryDirectory, 'static-office.docx'); await writeFile(docxPath, await createDocxFixture());
  const pptxPath = join(temporaryDirectory, 'static-office.pptx'); await writeFile(pptxPath, await createPptxFixture());
  const xlsxPath = join(temporaryDirectory, 'static-office.xlsx'); const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Evidence'); sheet.addRows([['Account', 'Amount'], ['Synthetic account', 1234]]); await workbook.xlsx.writeFile(xlsxPath);
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configuration = { origin, appUrl: `${origin}${base}`, api: 'https://static-api-fixture.invalid/v1', key: 'static-user-fixture-key-not-a-secret', evidence: evidenceDirectory, pdf: pdfPath, image: imagePath, office: [{ path: docxPath, name: 'static-office.docx' }, { path: pptxPath, name: 'static-office.pptx' }, { path: xlsxPath, name: 'static-office.xlsx' }] };
  const flowPath = join(temporaryDirectory, 'static-pages-flow.js');
  await writeFile(flowPath, browserFlow.toString().replace('__STATIC_CONFIG__', JSON.stringify(configuration)));
  await runCli('open', 'about:blank'); opened = true;
  const result = await runCli('run-code', '--filename', flowPath);
  assert.match(result, /"success"\s*:\s*true/, 'The browser flow did not complete.');
  await writeFile(join(evidenceDirectory, 'browser-result.txt'), result);
  const manual = JSON.parse(await readFile(join(evidenceDirectory, 'manual.json'), 'utf8'));
  const completed = JSON.parse(await readFile(join(evidenceDirectory, 'completed.json'), 'utf8'));
  assert.equal(manual.pages[0].blocks[0].label, 'Manual check');
  assert.equal(manual.pages[0].blocks[0].source, 'manual');
  assert.equal(completed.pages.length, 3);
  for (const page of completed.pages) {
    assert.equal(page.status, 'complete');
    assert.equal(page.blocks.filter(block => block.source === 'ai').length, 1);
    assert.equal(page.blocks.find(block => block.source === 'ai').label, 'Required label');
    assert.ok(page.blocks.every(block => !block.provisional));
  }
  const annotated = await PDFDocument.load(await readFile(join(evidenceDirectory, 'manual-annotated.pdf')));
  assert.equal(annotated.getPageCount(), 3);
  const first = annotated.getPage(0);
  assert.equal(first.getRotation().angle, 90);
  assert.deepEqual(first.getCropBox(), { x: 30, y: 50, width: 520, height: 650 });
  const annots = first.node.lookup(PDFName.of('Annots'), PDFArray);
  assert.equal(annots.size(), 1, 'Native export must contain an editable PDF comment.');
  const comment = annots.lookup(0, PDFDict);
  const content = comment.lookup(PDFName.of('Contents'));
  assert.ok(content instanceof PDFHexString || content instanceof PDFString);
  assert.match(content.decodeText(), /Manual check/);
  const bounds = manual.pages[0].blocks[0].bbox;
  const expectedRect = [bounds.y * 520 + 30, bounds.x * 650 + 50, (bounds.y + bounds.height) * 520 + 30, (bounds.x + bounds.width) * 650 + 50];
  const rect = comment.lookup(PDFName.of('Rect'), PDFArray);
  expectedRect.forEach((value, index) => assert.ok(Math.abs(rect.lookup(index, PDFNumber).asNumber() - value) < .01, 'Native comment position must account for CropBox and rotation.'));
  assert.ok(first.node.Resources()?.get(PDFName.of('Font')), 'Native export must retain the source PDF fonts.');
  assert.ok(serverRequests.every(request => request.method === 'GET' && request.pathname.startsWith(base) && !request.pathname.includes('/api/') && !request.authorization), 'The static server must receive only public assets, never /api calls, uploads or keys.');
  const screenshot = await sharp(join(evidenceDirectory, 'completed-1440x900.png')).metadata();
  assert.equal(screenshot.width, 1440); assert.equal(screenshot.height, 900);
  console.log('Static Pages E2E passed: English blank start, subpath assets/GitHub link, cached paper demo, local PDF/image/Office imports, manual annotation and rotated native PDF export, actual SDK Responses SSE with three parallel pages and strict labels, endpoint-only session key, no backend HTTP requests, and a full 1440×900 screenshot.');
} finally {
  if (opened) await runCli('close').catch(() => {});
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
