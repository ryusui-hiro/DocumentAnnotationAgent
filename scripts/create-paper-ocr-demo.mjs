import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { paperOcrPrompt, runPaperOcrWithCodex } from '../server/paperOcr.ts';
import { resolveCodexAppServerBinary } from '../server/codexAppServer.ts';

const demoDirectory = resolve('public/demos');
const evidenceDirectory = resolve('output/paper-ocr');
const sourcePath = resolve(evidenceDirectory, 'dall-e-full.pdf');
const pdfPath = resolve(demoDirectory, 'openai-paper-selected.pdf');
const dataPath = resolve(demoDirectory, 'openai-paper-ocr.json');
const sourcePages = [1, 2, 5];
const pdfUrl = 'https://proceedings.mlr.press/v139/ramesh21a/ramesh21a.pdf';
const instruction = 'Extract this real OpenAI research paper page into accurate layout blocks, faithfully transcribing prose, captions, table values, and any displayed mathematical equation. Keep original English text and mathematical symbols. Do not summarize.';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(demoDirectory, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

let source;
try { source = await readFile(sourcePath); }
catch {
  const response = await fetch(pdfUrl, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `Paper download failed: HTTP ${response.status}`);
  source = Buffer.from(await response.arrayBuffer());
  assert.ok(source.subarray(0, 5).toString() === '%PDF-' && source.length < 30 * 1024 * 1024, 'Source must be a bounded PDF.');
  await writeFile(sourcePath, source);
}
const original = await PDFDocument.load(source);
const selected = await PDFDocument.create();
for (const page of await selected.copyPages(original, sourcePages.map((number) => number - 1))) selected.addPage(page);
selected.setTitle('Zero-Shot Text-to-Image Generation — selected pages 1, 2, 5');
selected.setAuthor('Aditya Ramesh et al.');
selected.setSubject('Selected pages from the original PMLR publication for a visual OCR demonstration. CC BY 4.0.');
selected.setCreationDate(new Date('2021-07-01T00:00:00Z'));
selected.setModificationDate(new Date('2021-07-01T00:00:00Z'));
const selectedBytes = Buffer.from(await selected.save());
await writeFile(pdfPath, selectedBytes);

const renderStarted = Date.now();
const previewPages = [];
const paper = {
  title: 'Zero-Shot Text-to-Image Generation',
  authors: ['Aditya Ramesh', 'Mikhail Pavlov', 'Gabriel Goh', 'Scott Gray', 'Chelsea Voss', 'Alec Radford', 'Mark Chen', 'Ilya Sutskever'],
  sourceUrl: 'https://openai.com/index/dall-e/', pdfUrl,
  publicationUrl: 'https://proceedings.mlr.press/v139/ramesh21a.html',
  citation: 'Ramesh et al. (2021). Zero-Shot Text-to-Image Generation. Proceedings of the 38th International Conference on Machine Learning, PMLR 139:8821–8831.',
  license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  licenseSourceUrl: 'https://proceedings.mlr.press/pmlr-license-agreement.html',
  description: 'Original OpenAI DALL·E research paper. Selected original pages 1, 2, and 5 show the title, prose, figures, an actual numbered ELB equation, and Table 1.',
  sourcePages, originalPageCount: original.getPageCount(),
  sourceSha256: digest(source), selectedSha256: digest(selectedBytes), selectedPdfUrl: '/demos/openai-paper-selected.pdf',
  modifications: 'Only original pages 1, 2, and 5 are included; their visible content is unchanged. OCR labels and transcriptions are separate model-generated annotations.',
};
let existing;
try { existing = JSON.parse(await readFile(dataPath, 'utf8')); } catch { /* First preparation has no model output. */ }
const promptSha256 = digest(paperOcrPrompt(instruction));
const canReuse = existing?.paper?.sourceSha256 === paper.sourceSha256 && existing?.provenance?.promptSha256 === promptSha256;
const pages = canReuse ? [...existing.pages] : [];
const images = [];
for (let index = 0; index < sourcePages.length; index += 1) {
  const prefix = resolve(evidenceDirectory, `page-${index + 1}-source-${sourcePages[index]}`);
  // The vector converter substitutes some embedded math glyphs in this paper.
  // Render the actual PDF with Poppler so both the model and viewer see them.
  await promisify(execFile)('pdftoppm', ['-f', String(index + 1), '-l', String(index + 1), '-r', '180', '-singlefile', '-png', pdfPath, prefix]);
  const png = await readFile(`${prefix}.png`);
  const { width, height } = selected.getPage(index).getSize();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
  previewPages.push({ number: index + 1, svg, widthPoints: width, heightPoints: height, nodeCount: 1, warningCount: 0, warnings: [], estimatedIrBytes: Buffer.byteLength(svg) });
  images.push(png);
}
const report = {
  converter: 'poppler-pdf-raster', version: '180-dpi', source: 'openai-paper-selected.pdf', sourceFormat: 'pdf',
  elapsedMs: Date.now() - renderStarted, inputBytes: selectedBytes.length, pageCount: sourcePages.length,
  largestPageIrBytes: Math.max(...previewPages.map((page) => page.estimatedIrBytes)), pages: previewPages,
  warnings: [], needsReview: false,
};
await writeFile(resolve(demoDirectory, 'openai-paper-preview.json'), JSON.stringify(report));
const provenance = {
  kind: 'live-model-output', model: 'gpt-6-astra', provider: 'codex-app-server', reasoningEffort: 'medium',
  binary: resolveCodexAppServerBinary(), promptSha256, instruction,
  imageSource: 'Original PDF rendered by Poppler at 180 DPI; the model receives only that page image, without extracted PDF text. The viewer uses the identical raster in an SVG wrapper to preserve embedded math glyphs.',
  imageSha256: images.map(digest), converter: `${report.converter} ${report.version}`,
  generatedAt: existing?.provenance?.generatedAt ?? null,
  complete: pages.length === sourcePages.length,
  limitations: [
    'This is model-based visual OCR, not a verified ground-truth transcription. Small symbols, table structure, and page boundaries require human review.',
    'Only the three stated original pages are included. No claim is made about OCR coverage of the full paper.',
    'Stored demo results are actual prior GPT-6 Astra outputs. Opening the demo makes no new model request; rerunning a page consumes provider usage.',
  ],
};
const save = async () => {
  provenance.complete = pages.length === sourcePages.length;
  provenance.totalTokens = pages.reduce((sum, page) => sum + (page.usage?.totalTokens ?? 0), 0);
  await writeFile(dataPath, `${JSON.stringify({ paper, pages, provenance }, null, 2)}\n`);
};
await save();
process.stdout.write(`Prepared ${pdfPath}; original pages ${sourcePages.join(', ')}.\n`);
if (process.env.ANNOTATION_STUDIO_LIVE_SMOKE !== '1') {
  process.stdout.write('No model calls made. Set ANNOTATION_STUDIO_LIVE_SMOKE=1 to generate actual page OCR using the signed-in Codex account.\n');
} else {
  for (let index = 0; index < images.length; index += 1) {
    if (pages.some((page) => page.pageNumber === index + 1)) {
      process.stdout.write(`Retained previously generated page ${index + 1}; no repeated model call.\n`);
      continue;
    }
    process.stdout.write(`GPT-6 Astra OCR ${index + 1}/${images.length}: original page ${sourcePages[index]}.\n`);
    const result = await runPaperOcrWithCodex({
      imageDataUrl: `data:image/png;base64,${images[index].toString('base64')}`,
      model: 'gpt-6-astra', reasoningEffort: 'medium', instruction, pageNumber: index + 1, sourcePageNumber: sourcePages[index],
    });
    pages.push(result);
    pages.sort((left, right) => left.pageNumber - right.pageNumber);
    provenance.generatedAt = new Date().toISOString();
    await save();
    process.stdout.write(`Saved ${result.blocks.length} actual blocks; ${result.usage.totalTokens} tokens.\n`);
  }
  const types = new Set(pages.flatMap((page) => page.blocks.map((block) => block.type)));
  for (const type of ['title', 'text', 'figure', 'table', 'equation']) assert.ok(types.has(type), `Actual model output must include ${type}.`);
  assert.ok(pages.find((page) => page.sourcePageNumber === 2)?.blocks.some((block) => block.type === 'equation' && block.latex), 'The original numbered equation needs actual extracted LaTeX.');
  process.stdout.write(`Live paper OCR verified: ${pages.length} pages; ${[...types].join(', ')}; ${provenance.totalTokens} tokens. Data: ${dataPath}\n`);
}
