import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

const demos = new URL('../public/demos/', import.meta.url);
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('real paper OCR demo preserves source pages, actual model provenance, and image evidence', async () => {
  const demo = JSON.parse(await readFile(new URL('openai-paper-ocr.json', demos), 'utf8'));
  const selectedBytes = await readFile(new URL('openai-paper-selected.pdf', demos));
  const preview = JSON.parse(await readFile(new URL('openai-paper-preview.json', demos), 'utf8'));
  const pdf = await PDFDocument.load(selectedBytes);
  assert.equal(pdf.getPageCount(), 3);
  assert.deepEqual(demo.paper.sourcePages, [1, 2, 5]);
  assert.equal(demo.paper.selectedSha256, digest(selectedBytes));
  assert.equal(demo.paper.license, 'CC BY 4.0');
  assert.equal(demo.provenance.kind, 'live-model-output');
  assert.equal(demo.provenance.complete, true, 'Run the intentional live demo builder before shipping this sample.');
  assert.ok(demo.provenance.totalTokens > 0);
  assert.equal(demo.pages.length, 3);
  for (const [index, page] of demo.pages.entries()) {
    assert.equal(page.model, 'gpt-6-astra');
    assert.equal(page.provider, 'codex-app-server');
    assert.equal(page.pageNumber, index + 1);
    assert.equal(page.sourcePageNumber, demo.paper.sourcePages[index]);
    assert.ok(page.usage.totalTokens > 0);
    const image = preview.pages[index].svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    assert.ok(image, 'Demo SVG should retain the faithful source raster.');
    assert.equal(digest(Buffer.from(image[1], 'base64')), demo.provenance.imageSha256[index], 'Viewer image must match the exact image sent to GPT-6 Astra.');
    for (const block of page.blocks) {
      assert.ok(block.bbox.x >= 0 && block.bbox.y >= 0 && block.bbox.width > 0 && block.bbox.height > 0);
      assert.ok(block.bbox.x + block.bbox.width <= 1.000001 && block.bbox.y + block.bbox.height <= 1.000001);
    }
  }
  const title = demo.pages[0].blocks.find((block) => block.type === 'title');
  assert.equal(title.extractedText, 'Zero-Shot Text-to-Image Generation');
  assert.ok(demo.pages[1].blocks.some((block) => block.type === 'equation' && block.latex), 'Original page 2 contains an actual displayed equation.');
  assert.ok(demo.pages[2].blocks.some((block) => block.type === 'table' && /Compression/i.test(block.extractedText)), 'Original page 5 contains the compression-rank table.');
  assert.ok(demo.pages.some((page) => page.blocks.some((block) => block.type === 'figure')));
  assert.ok(fileURLToPath(demos).endsWith('/public/demos/'));
});
