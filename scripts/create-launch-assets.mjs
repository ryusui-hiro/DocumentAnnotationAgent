/**
 * Rebuild the English launch assets: node scripts/create-launch-assets.mjs
 * The launch-source PNGs are untouched full-viewport captures from the real app.
 * This script only adds a title/background and uniformly scales each screenshot.
 * It never reconstructs UI, crops the viewport, or modifies screenshot content.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/product-hunt/assets');
await fs.mkdir(output, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const scanPaths = [
  'M3 7V5a2 2 0 0 1 2-2h2',
  'M17 3h2a2 2 0 0 1 2 2v2',
  'M21 17v2a2 2 0 0 1-2 2h-2',
  'M7 21H5a2 2 0 0 1-2-2v-2',
  'M7 12h10',
].map(d => `<path d="${d}"/>`).join('');
// Lucide ScanLine, ISC license; the same paths and charcoal as the app's brand mark.
const mark = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 30 30"><rect width="30" height="30" rx="8" fill="#323330"/><g transform="translate(6 6) scale(.75)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${scanPaths}</g></svg>`;
const thumbnail = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Astra Annotator app icon</title><rect width="1024" height="1024" fill="#f6f5f1"/>${mark(84, 84, 856)}</svg>`;
await fs.writeFile(path.join(output, 'launch-thumbnail.svg'), thumbnail);
await sharp(Buffer.from(thumbnail)).png().toFile(path.join(output, 'launch-thumbnail-1024.png'));

const galleries = [
  {
    id: '01-live',
    title: 'Watch annotations appear as AI works.',
    subtitle: 'Process pages concurrently. Keep your own notes alongside AI annotations.',
    source: 'launch-source-live.png',
    originalCapture: 'output/recordings/parallel-en/video-check-live.png',
    state: 'Real live run: three pages processing; incoming regions and a manual reviewer note visible.',
  },
  {
    id: '02-equations',
    title: 'Turn equations into editable LaTeX.',
    subtitle: 'Keep the source region, rendered formula, and editable expression together.',
    source: 'launch-source-equations.png',
    originalCapture: 'output/recordings/parallel-en/latex-visible.png',
    state: 'Completed real run: an equation region selected with its LaTeX editor visible.',
  },
  {
    id: '03-tables',
    title: 'Bring table values into your annotations.',
    subtitle: 'Review extracted text and notes beside the table they came from.',
    source: 'launch-source-tables.png',
    originalCapture: 'output/recordings/parallel-en/table-values-visible.png',
    state: 'Completed real run: a table region selected with its extracted source text visible.',
  },
  {
    id: '04-workspace',
    title: 'Your documents. Your direction.',
    subtitle: 'Open a document, describe what matters, and annotate with AI or by hand.',
    source: 'launch-source-workspace.png',
    originalCapture: 'output/playwright/unified-welcome-en-1600x1000.png',
    state: 'Real welcome screen: supported document formats, instruction field, and Open document action.',
  },
];
const manifest = {
  product: 'Astra Annotator',
  tagline: 'Annotate documents live with AI, on your terms',
  url: 'https://ryusui-hiro.github.io/DocumentAnnotationAgent/',
  regenerate: 'node scripts/create-launch-assets.mjs',
  thumbnail: { file: 'launch-thumbnail-1024.png', width: 1024, height: 1024, source: 'launch-thumbnail.svg' },
  galleries: [],
  provenance: 'Screenshots are genuine full app viewports. Only uniform scaling and an external presentation frame are applied. No UI or data is fabricated.',
  paper: { title: 'Zero-Shot Text-to-Image Generation', url: 'https://arxiv.org/abs/2102.12092', license: 'CC BY 4.0', attribution: 'Aditya Ramesh, Mikhail Pavlov, Gabriel Goh, Scott Gray, Chelsea Voss, Alec Radford, Mark Chen, Ilya Sutskever (2021).' },
};
for (const [index, gallery] of galleries.entries()) {
  const source = path.join(output, gallery.source);
  // Bootstrap from existing evidence once; later runs use the preserved source.
  try { await fs.access(source); } catch { await fs.copyFile(path.join(root, gallery.originalCapture), source); }
  const sourceBuffer = await fs.readFile(source);
  const metadata = await sharp(sourceBuffer).metadata();
  if (metadata.width !== 1600 || metadata.height !== 1000) throw new Error(`${gallery.source}: expected 1600 × 1000 full viewport.`);
  const screenshot = await sharp(sourceBuffer).resize(1504, 940, { fit: 'contain' }).png().toBuffer();
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
    <rect width="1600" height="1200" fill="#f6f5f1"/>
    ${mark(48, 28, 30)}
    <g font-family="Arial, Helvetica, sans-serif" fill="#323330">
      <text x="90" y="50" font-size="22" font-weight="700">Astra Annotator</text>
      <text x="1552" y="49" text-anchor="end" font-size="16" fill="#74756d">${String(index + 1).padStart(2, '0')} / 04</text>
      <text x="48" y="119" font-size="49" font-weight="700" letter-spacing="-1.3">${xml(gallery.title)}</text>
      <text x="48" y="159" font-size="23" fill="#6c6e65">${xml(gallery.subtitle)}</text>
      <rect x="47" y="207" width="1506" height="942" rx="1" fill="#fff" stroke="#d8d9d0"/>
      <text x="48" y="1180" font-size="14" fill="#77796f">${index < 3 ? 'LIVE APP CAPTURE · Paper: Ramesh et al. (2021), Zero-Shot Text-to-Image Generation · CC BY 4.0' : 'LIVE APP CAPTURE · PDF, Word, PowerPoint, Excel and images'}</text>
      <text x="1552" y="1180" text-anchor="end" font-size="14" fill="#77796f">Annotate documents live with AI, on your terms</text>
    </g>
  </svg>`;
  const file = `launch-gallery-${gallery.id}-1600x1200.png`;
  await sharp(Buffer.from(background)).composite([{ input: screenshot, left: 48, top: 208 }]).png().toFile(path.join(output, file));
  manifest.galleries.push({ ...gallery, file, width: 1600, height: 1200, sourceWidth: metadata.width, sourceHeight: metadata.height, sourceSha256: createHash('sha256').update(sourceBuffer).digest('hex'), screenshotPlacement: { left: 48, top: 208, width: 1504, height: 940, cropped: false } });
  console.log(`${file} — 1600 × 1200; complete screenshot viewport retained`);
}
await fs.writeFile(path.join(output, 'launch-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('launch-thumbnail-1024.png — 1024 × 1024');
