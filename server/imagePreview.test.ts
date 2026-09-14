import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { previewRasterImage } from './imagePreview';

test('normalizes a large PNG into a single bounded SVG page', async () => {
  const input = await sharp({
    create: { width: 5000, height: 80, channels: 4, background: { r: 30, g: 90, b: 150, alpha: 0.7 } },
  }).png().toBuffer();
  const report = await previewRasterImage('scan.png', input);

  assert.equal(report.sourceFormat, 'PNG');
  assert.equal(report.pageCount, 1);
  assert.equal(report.needsReview, true);
  assert.match(report.warnings[0] ?? '', /縮小しました/);
  const dataUri = report.pages[0]?.svg.match(/href="data:image\/png;base64,([^"]+)"/)?.[1];
  assert.ok(dataUri);
  const embedded = await sharp(Buffer.from(dataUri, 'base64')).metadata();
  assert.equal(embedded.width, 4096);
  assert.equal(embedded.height, 66);
  assert.match(report.pages[0]?.svg ?? '', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('accepts WebP and TIFF and normalizes them to browser-safe image data', async () => {
  const base = sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 90, g: 140, b: 190 } },
  });
  const webp = await base.clone().webp().toBuffer();
  const tiff = await base.clone().tiff().toBuffer();
  const webpReport = await previewRasterImage('sample.webp', webp);
  const tiffReport = await previewRasterImage('sample.tiff', tiff);

  assert.equal(webpReport.sourceFormat, 'WEBP');
  assert.match(webpReport.pages[0]?.svg ?? '', /data:image\/webp;base64,/);
  assert.equal(tiffReport.sourceFormat, 'TIFF');
  assert.match(tiffReport.pages[0]?.svg ?? '', /data:image\/png;base64,/);
});

test('rejects extension mismatches and unsupported formats', async () => {
  const png = await sharp({
    create: { width: 16, height: 12, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  await assert.rejects(() => previewRasterImage('photo.jpg', png), (error: Error & { status?: number }) => error.status === 415);
  await assert.rejects(() => previewRasterImage('animation.gif', png), (error: Error & { status?: number }) => error.status === 415);
});
