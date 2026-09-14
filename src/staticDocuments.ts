import JSZip from 'jszip';
import type { ConvertedDocument, ConvertedPage } from './types';

export const STATIC_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const STATIC_MAX_PAGES = 120;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;
const OFFICE_WARNING = 'Browser text preview: text is reflowed into new pages. Original pagination, formatting, images, charts, and embedded objects are not preserved. Use the local app or a configured backend for the original Office layout.';

export interface StaticDocumentImport {
  document: ConvertedDocument;
  /** Original bytes stay in this browser and can be used for local exports. */
  sourceBuffer: Uint8Array;
  /** One self-contained SVG per page, in the same order as document.pages. */
  svgs: string[];
  /** PDF user space → displayed page space, including rotation and CropBox. */
  pdfTransforms?: number[][];
}

type PreviewPage = { svg: string; width: number; height: number; warnings: string[]; pdfTransform?: number[] };

export function escapeStaticXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/\r\n?/g, '\n');
}

/** Deliberately creates only text and raster-image nodes, never source markup. */
export function staticTextPages(title: string, paragraphs: readonly string[], warnings: string[] = [OFFICE_WARNING]): PreviewPage[] {
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    for (const sourceLine of cleanText(paragraph).split('\n')) {
      let line = '';
      let units = 0;
      for (const character of sourceLine.replaceAll('\t', '    ')) {
        const cost = character.codePointAt(0)! > 255 ? 2 : 1;
        if (units + cost > 76) { lines.push(line); line = ''; units = 0; }
        line += character; units += cost;
      }
      lines.push(line);
    }
    lines.push('');
  }
  if (!lines.some((line) => line.trim())) lines.splice(0, lines.length, '[No body text was found in this part of the document.]');
  const pageCount = Math.ceil(lines.length / 35);
  if (pageCount > STATIC_MAX_PAGES) throw new Error(`The browser preview exceeds ${STATIC_MAX_PAGES} pages. Split the document or use a backend.`);
  return Array.from({ length: pageCount }, (_, index) => {
    const visibleLines = lines.slice(index * 35, (index + 1) * 35);
    const headingCharacters = Array.from(cleanText(title));
    const heading = headingCharacters.slice(0, 35).join('') + (headingCharacters.length > 35 ? '…' : '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792"><rect width="612" height="792" fill="white"/><g font-family="Arial, sans-serif" fill="#162c34"><text x="42" y="40" font-size="14" font-weight="bold">${escapeStaticXml(heading)}</text><text x="42" y="61" font-size="9" fill="#65757c">Browser text preview · reflowed layout · ${index + 1}/${pageCount}</text><path d="M42 75H570" stroke="#d7dee0"/>${visibleLines.map((line, offset) => `<text x="42" y="${103 + offset * 18}" font-size="12" xml:space="preserve">${escapeStaticXml(line)}</text>`).join('')}<text x="42" y="766" font-size="9" fill="#65757c">Text preview only — original page positions are not represented.</text></g></svg>`;
    return { svg, width: 612, height: 792, warnings: [...warnings] };
  });
}

function rasterPage(canvas: HTMLCanvasElement, width: number, height: number, warnings: string[] = []): PreviewPage {
  const data = canvas.toDataURL('image/png');
  return { width, height, warnings, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="${data}"/></svg>` };
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

function previewScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The document contains invalid page dimensions.');
  return Math.min(1.75, 2400 / width, 2400 / height, Math.sqrt(3_000_000 / (width * height)));
}

async function pdfPages(source: Uint8Array): Promise<PreviewPage[]> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const assetRoot = `${import.meta.env.BASE_URL}pdfjs/`;
  const task = pdfjs.getDocument({
    // PDF.js transfers ownership to its worker. Keep the original for export.
    data: source.slice(),
    cMapUrl: `${assetRoot}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assetRoot}standard_fonts/`, wasmUrl: `${assetRoot}wasm/`,
    enableXfa: false,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > STATIC_MAX_PAGES) throw new Error(`The PDF has ${pdf.numPages} pages. The browser limit is ${STATIC_MAX_PAGES}; split the PDF or use a backend.`);
    const pages: PreviewPage[] = [];
    let previewBytes = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: previewScale(base.width, base.height) });
      const canvas = canvasFor(viewport.width, viewport.height);
      try {
        await page.render({ canvas, viewport }).promise;
        const converted = rasterPage(canvas, base.width, base.height);
        converted.pdfTransform = [...base.transform];
        previewBytes += converted.svg.length;
        if (previewBytes > MAX_PREVIEW_BYTES) throw new Error('Rendered pages exceed the browser memory limit. Split the PDF or use a backend.');
        pages.push(converted);
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
    }
    return pages;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('This PDF is password protected. Open an unlocked copy or use the local app.');
    throw error;
  } finally { await task.destroy(); }
}

export function staticImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 4 && ((bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0) || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42))) return 'image/tiff';
  return null;
}

export function staticImageIsAnimated(bytes: Uint8Array, mime: string): boolean {
  const word = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (mime === 'image/webp') return bytes.length >= 21 && word(12) === 'VP8X' && Boolean(bytes[20] & 2);
  if (mime !== 'image/png') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return false;
    if (word(offset + 4) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

async function imagePages(source: Uint8Array, extension: string): Promise<PreviewPage[]> {
  const expected = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' } as Record<string, string>)[extension];
  const mime = staticImageMime(source);
  if (!mime || mime !== expected) throw new Error('The image contents do not match its extension. Choose a valid PNG, JPEG, WebP, or TIFF file.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([source.slice().buffer], { type: mime })); }
  catch { throw new Error(mime === 'image/tiff' ? 'This browser cannot decode TIFF. Convert it to PNG or use the local app or a configured backend.' : 'The browser could not decode this image. Check that the file is not damaged.'); }
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Images are limited to 40 million pixels. Resize the image before importing.');
    const scale = Math.min(1, previewScale(bitmap.width, bitmap.height));
    const canvas = canvasFor(bitmap.width * scale, bitmap.height * scale);
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const warnings = scale < 1 ? ['The image was downscaled for the browser preview. Original bytes are retained for export.'] : [];
      if (mime === 'image/tiff' || staticImageIsAnimated(source, mime)) warnings.push('Only the first image/frame is shown. Split multi-page or animated images before importing.');
      return [rasterPage(canvas, bitmap.width, bitmap.height, warnings)];
    } finally { canvas.width = canvas.height = 0; }
  } finally { bitmap.close(); }
}

const descendants = (element: Document | Element, name: string): Element[] => Array.from(element.getElementsByTagNameNS('*', name));
const textRuns = (element: Element): string => descendants(element, 't').map((item) => item.textContent ?? '').join('');

function paragraphText(element: Element): string {
  const read = (node: Element): string => {
    if (['del', 'drawing', 'pict'].includes(node.localName)) return '';
    if (node.localName === 't') return node.textContent ?? '';
    if (node.localName === 'tab') return '\t';
    if (node.localName === 'br' || node.localName === 'cr') return '\n';
    return Array.from(node.childNodes).filter((child) => child.nodeType === 1).map((child) => read(child as Element)).join('');
  };
  return read(element);
}

function parseOfficeXml(xml: string): Document {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Office files containing XML entity declarations are not supported.');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (descendants(parsed, 'parsererror').length) throw new Error('The Office document contains malformed XML.');
  return parsed;
}

/** Resolve only internal package paths; external links are never fetched. */
export function staticPackagePath(base: string, target: string): string | null {
  if (!target || /[\\?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

async function officePages(source: Uint8Array, extension: string, fileName: string): Promise<PreviewPage[]> {
  const zip = await JSZip.loadAsync(source);
  if (Object.keys(zip.files).length > 4000) throw new Error('This Office archive contains too many parts for the browser. Use a backend.');
  let xmlBytes = 0;
  const xml = async (path: string): Promise<Document> => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`The Office package is missing ${path}.`);
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (declaredSize && declaredSize > MAX_XML_BYTES) throw new Error('An Office XML part exceeds the browser size limit.');
    const content = await entry.async('uint8array');
    xmlBytes += content.byteLength;
    if (content.byteLength > MAX_XML_BYTES || xmlBytes > MAX_XML_TOTAL_BYTES) throw new Error('Office text exceeds the browser size limit. Use a backend.');
    return parseOfficeXml(new TextDecoder().decode(content));
  };
  const pages: PreviewPage[] = [];
  const append = (title: string, paragraphs: string[], warnings: string[] = [OFFICE_WARNING]) => {
    pages.push(...staticTextPages(title, paragraphs, warnings));
    if (pages.length > STATIC_MAX_PAGES) throw new Error(`The reflowed document exceeds ${STATIC_MAX_PAGES} pages. Split it or use a backend.`);
  };
  const relationships = (document: Document, base: string) => new Map(descendants(document, 'Relationship').flatMap((relation) => {
    if (relation.getAttribute('TargetMode')?.toLowerCase() === 'external') return [];
    const path = staticPackagePath(base, relation.getAttribute('Target') ?? '');
    const id = relation.getAttribute('Id');
    return path && id ? [[id, path] as const] : [];
  }));
  const relationshipId = (element: Element) => element.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? element.getAttribute('r:id') ?? '';
  if (extension === 'docx') {
    const body = (await xml('word/document.xml')).documentElement;
    const paragraphs = descendants(body, 'p').filter((paragraph) => {
      for (let ancestor = paragraph.parentNode; ancestor?.nodeType === 1; ancestor = ancestor.parentNode) {
        if (['del', 'drawing', 'pict'].includes((ancestor as Element).localName)) return false;
      }
      return true;
    }).map(paragraphText);
    append(fileName, paragraphs, [OFFICE_WARNING, 'Only main-document body text is included; headers, footers, notes, and tracked deletions are excluded.']);
  } else if (extension === 'pptx') {
    const presentation = await xml('ppt/presentation.xml');
    const rels = relationships(await xml('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
    const slides = descendants(presentation, 'sldId');
    if (slides.length > STATIC_MAX_PAGES) throw new Error(`Presentations are limited to ${STATIC_MAX_PAGES} slides in the browser.`);
    for (const [index, slide] of slides.entries()) {
      const path = rels.get(relationshipId(slide));
      if (!path) throw new Error(`Slide ${index + 1} does not have a supported internal source.`);
      const document = await xml(path);
      append(`${fileName} · Slide ${index + 1}`, descendants(document, 'p').map(paragraphText), [OFFICE_WARNING, 'Slide text is shown in document order. Speaker notes, diagrams, and visual reading order are not represented.']);
    }
  } else {
    const workbook = await xml('xl/workbook.xml');
    const rels = relationships(await xml('xl/_rels/workbook.xml.rels'), 'xl/workbook.xml');
    const strings = zip.file('xl/sharedStrings.xml') ? descendants(await xml('xl/sharedStrings.xml'), 'si').map(textRuns) : [];
    const sheets = descendants(workbook, 'sheet');
    for (const sheet of sheets) {
      const path = rels.get(relationshipId(sheet));
      if (!path) throw new Error(`Worksheet ${sheet.getAttribute('name') ?? ''} does not have a supported internal source.`);
      const document = await xml(path);
      const cells = descendants(document, 'c');
      if (cells.length > 30_000) throw new Error('A worksheet has too many populated cells for the browser text preview. Split it or use a backend.');
      const rows: string[] = [];
      let uncachedFormula = false;
      for (const cell of cells) {
        const address = cell.getAttribute('r') ?? '';
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error('The workbook contains an invalid cell address.');
        const type = cell.getAttribute('t');
        const value = descendants(cell, 'v')[0]?.textContent ?? '';
        const formula = descendants(cell, 'f')[0]?.textContent;
        let text = type === 's' ? strings[Number(value)] : type === 'inlineStr' ? textRuns(cell) : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value;
        if (type === 's' && (!/^\d+$/.test(value) || text === undefined)) throw new Error('The workbook contains an invalid shared-string reference.');
        if (formula && !value) { text = `[Formula without a cached result: =${formula}]`; uncachedFormula = true; }
        if (text) rows.push(`${address}: ${text}`);
      }
      append(`${fileName} · ${sheet.getAttribute('name') ?? 'Worksheet'}`, rows, [OFFICE_WARNING, 'Worksheet cells are listed with their addresses; numeric dates are shown as stored values. Formula results are cached values and are not recalculated.', ...(uncachedFormula ? ['Some formulas have no cached result; their formulas are shown instead of calculated values.'] : [])]);
    }
  }
  if (!pages.length) throw new Error('The Office file contains no readable document parts.');
  return pages;
}

export async function importStaticDocument(file: File): Promise<StaticDocumentImport> {
  const startedAt = performance.now();
  if (!file.size) throw new Error('The selected file is empty.');
  if (file.size > STATIC_MAX_FILE_BYTES) throw new Error('Browser imports are limited to 30 MB per file. Use a smaller file or a backend.');
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'docx', 'pptx', 'xlsx'].includes(extension)) throw new Error('Choose a PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PNG, JPEG, WebP, or TIFF file.');
  const sourceBuffer = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', sourceBuffer);
  const sourceHash = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
  const pages = extension === 'pdf' ? await pdfPages(sourceBuffer) : ['docx', 'pptx', 'xlsx'].includes(extension) ? await officePages(sourceBuffer, extension, file.name) : await imagePages(sourceBuffer, extension);
  if (!pages.length || pages.length > STATIC_MAX_PAGES) throw new Error(`Documents must contain between 1 and ${STATIC_MAX_PAGES} preview pages.`);
  if (pages.reduce((total, page) => total + page.svg.length, 0) > MAX_PREVIEW_BYTES) throw new Error('The document preview exceeds the browser memory limit. Split it or use a backend.');
  const warnings = [...new Set(pages.flatMap((page) => page.warnings))];
  const metadata: ConvertedPage[] = pages.map((page, index) => ({ pageNumber: index + 1, width: page.width, height: page.height, warnings: page.warnings, warningCount: page.warnings.length }));
  return { document: { documentId: crypto.randomUUID(), sourceHash, fileName: file.name, fileType: extension, pageCount: pages.length, elapsedMs: Math.round(performance.now() - startedAt), needsReview: Boolean(warnings.length), warnings, pages: metadata, demo: false }, sourceBuffer, svgs: pages.map((page) => page.svg), ...(extension === 'pdf' ? { pdfTransforms: pages.map((page) => page.pdfTransform!) } : {}) };
}
