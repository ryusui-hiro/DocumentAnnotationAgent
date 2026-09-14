import type { PreviewReport } from 'document-svg';
import sharp from 'sharp';
import type { Annotation, DocumentAnnotationRecord } from '../src/types';
import { appendPdfTextComment } from '../src/pdfAnnotation';
import { documentAnnotationsToCsv } from './annotationCsv';
import { extractPositionedTextBlocks, type PositionedTextBlock } from './textTarget';

export type DocumentLocation =
  | { kind: 'page'; pageNumber: number }
  | { kind: 'sheet'; sheetName: string; range?: string };

export interface DocumentSearchResult {
  location: DocumentLocation;
  excerpt: string;
  matchType: 'text' | 'cell';
}

export type DocumentOutline = {
  fileName: string;
  fileType: string;
  kind: 'paged' | 'spreadsheet';
  pageCount?: number;
  pages?: Array<{
    pageNumber: number;
    width: number;
    height: number;
    warningCount: number;
    headingCandidates?: PdfHeadingCandidate[];
  }>;
  sheets?: Array<{ name: string; rowCount: number; columnCount: number; headers: string[] }>;
};

export type PdfHeadingCandidate = {
  text: string;
  boundingBox: PositionedTextBlock['boundingBox'];
  fontSize: number;
  bold: boolean;
};

export type PageTextRowHint = {
  baselineY: number;
  cells: Array<{
    text: string;
    boundingBox: PositionedTextBlock['boundingBox'];
    fontSize?: number;
    bold?: boolean;
  }>;
};

export type DocumentView =
  | { kind: 'page'; pageNumber: number; width: number; height: number; svg: string; warnings: string[] }
  | { kind: 'sheet'; sheetName: string; summary: ReturnType<SpreadsheetInspector['inspectSheet']> }
  | { kind: 'range'; sheetName: string; range: string; rows: ReturnType<SpreadsheetInspector['readRange']>['rows']; cellCount: number };

export type DocumentExportFormat = 'annotations-json' | 'annotations-csv' | 'native-annotated';
export interface DocumentExportRequest {
  format: DocumentExportFormat;
  annotations?: DocumentAnnotationRecord[];
}
export interface DocumentExportResult {
  format: DocumentExportFormat;
  fileName: string;
  contentType: string;
  buffer: Buffer;
  annotationsExported: number;
  skipped: Array<{ annotationId: string; label: string; reason: string }>;
  metadata?: Record<string, number>;
}

export interface DocumentAdapter {
  readonly documentId?: string;
  /** Activates the already user-opened document session and returns its bounded structure. */
  open(): DocumentOutline;
  getStructure(): DocumentOutline;
  inspect(location: DocumentLocation): DocumentView;
  search(query: string, limit?: number): DocumentSearchResult[];
  annotate(annotation: DocumentAnnotationRecord): DocumentAnnotationRecord;
  replaceAnnotations(annotations: DocumentAnnotationRecord[]): void;
  listAnnotations(): DocumentAnnotationRecord[];
  removeAnnotation(annotationId: string): boolean;
  export(request: DocumentExportRequest): Promise<DocumentExportResult>;
}

export interface SpreadsheetInspector {
  readonly fileName: string;
  listSheets(): Array<{ name: string; rowCount: number; columnCount: number; headers: string[]; sampleRows: Array<{ rowNumber: number; values: Array<string | number | boolean | null> }> }>;
  inspectSheet(sheetName: string): { name: string; rowCount: number; columnCount: number; headers: string[]; sampleRows: Array<{ rowNumber: number; values: Array<string | number | boolean | null> }> };
  readRange(sheetName: string, range: string): { sheetName: string; range: string; rows: Array<Array<{ address: string; value: string | number | boolean | null }>>; cellCount: number };
  search(query: string, limit?: number): DocumentSearchResult[];
}

function fail(message: string, status = 404): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function decodeXml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code.toLowerCase() === 'amp') return '&';
    if (code.toLowerCase() === 'lt') return '<';
    if (code.toLowerCase() === 'gt') return '>';
    if (code.toLowerCase() === 'quot') return '"';
    if (code.toLowerCase() === 'apos') return "'";
    const hexadecimal = code.toLowerCase().startsWith('#x');
    const numeric = hexadecimal ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    try { return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity; } catch { return entity; }
  });
}

function extractSvgText(svg: string) {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text\s*>/gi)]
    .map((match) => decodeXml(match[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
}

function inferPdfHeadingCandidates(blocks: PositionedTextBlock[]): PdfHeadingCandidate[] {
  const fontSizes = blocks.map((block) => block.fontSize).filter((size): size is number => typeof size === 'number' && Number.isFinite(size) && size > 0).sort((left, right) => left - right);
  if (!fontSizes.length) return [];
  const typicalFontSize = fontSizes[Math.floor(fontSizes.length / 2)]!;
  return blocks
    .filter((block) => {
      const text = block.text.trim();
      if (!text || text.length > 48 || !Number.isFinite(block.fontSize) || block.fontSize! < 8) return false;
      if (/[.;:,!?]$/.test(text)) return false;
      if (/^[+-]?\d+(?:[.,]\d+)?\s+[A-Za-z°]{1,4}(?:\s|$)/.test(text)) return false;
      if (block.boundingBox.y < 0.015 || block.boundingBox.y > 0.92) return false;
      return block.fontSize! >= Math.max(12, typicalFontSize * 1.25) || (block.bold === true && block.fontSize! >= Math.max(10, typicalFontSize * 1.1));
    })
    .sort((left, right) => left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x)
    .slice(0, 12)
    .map((block) => ({
      text: block.text.slice(0, 160),
      boundingBox: { ...block.boundingBox },
      fontSize: Math.round(block.fontSize! * 10) / 10,
      bold: block.bold === true,
    }));
}

function inferPageTextRowHints(blocks: PositionedTextBlock[]): PageTextRowHint[] {
  const ordered = blocks
    .filter((block) => block.text.trim())
    .map((block) => ({ block, baselineY: block.boundingBox.y + block.boundingBox.height * 0.8 }))
    .sort((left, right) => left.baselineY - right.baselineY || left.block.boundingBox.x - right.block.boundingBox.x);
  const rows: Array<{ baselineY: number; height: number; cells: typeof ordered[number]['block'][] }> = [];
  for (const item of ordered) {
    const match = [...rows].reverse().find((row) => {
      const tolerance = Math.max(0.002, Math.min(0.012, Math.min(item.block.boundingBox.height, row.height) * 0.35));
      return Math.abs(row.baselineY - item.baselineY) <= tolerance;
    });
    if (match) {
      match.cells.push(item.block);
      match.baselineY = (match.baselineY * (match.cells.length - 1) + item.baselineY) / match.cells.length;
      match.height = Math.min(match.height, item.block.boundingBox.height);
    } else rows.push({ baselineY: item.baselineY, height: item.block.boundingBox.height, cells: [item.block] });
  }

  let remainingChars = 2400;
  return rows
    .filter((row) => row.cells.length > 1)
    .sort((left, right) => left.baselineY - right.baselineY)
    .slice(0, 24)
    .map((row) => ({
      baselineY: Math.round(row.baselineY * 10000) / 10000,
      cells: row.cells
        .sort((left, right) => left.boundingBox.x - right.boundingBox.x)
        .slice(0, 8)
        .flatMap((block) => {
          if (remainingChars <= 0) return [];
          const text = block.text.trim().slice(0, Math.min(180, remainingChars));
          remainingChars -= text.length;
          return [{ text, boundingBox: { ...block.boundingBox }, ...(block.fontSize ? { fontSize: block.fontSize } : {}), ...(block.bold ? { bold: true } : {}) }];
        }),
    }))
    .filter((row) => row.cells.length > 1 && row.cells.some((cell) => cell.text));
}

export class PagedDocumentAdapter implements DocumentAdapter {
  private readonly textCache = new Map<number, string[]>();
  private readonly positionedTextCache = new Map<number, string[]>();
  private readonly positionedTextBlocksCache = new Map<number, PositionedTextBlock[]>();
  private readonly headingCandidatesCache = new Map<number, PdfHeadingCandidate[]>();
  private readonly annotations = new Map<string, DocumentAnnotationRecord>();

  constructor(readonly fileName: string, readonly report: PreviewReport, readonly documentId = '', private readonly sourceBuffer?: Buffer) {}

  open(): DocumentOutline {
    if (!this.fileName.trim() || !Number.isInteger(this.report.pageCount) || this.report.pageCount < 1) {
      throw fail('The active uploaded document session is not ready to open.');
    }
    return this.getStructure();
  }

  getStructure(): DocumentOutline {
    return {
      fileName: this.fileName,
      fileType: this.report.sourceFormat,
      kind: 'paged',
      pageCount: this.report.pageCount,
      pages: this.report.pages.map((page) => ({
        pageNumber: page.number,
        width: page.widthPoints,
        height: page.heightPoints,
        warningCount: page.warningCount,
        ...(this.report.sourceFormat.toLowerCase() === 'pdf' ? { headingCandidates: this.getPageHeadingCandidates(page.number) } : {}),
      })),
    };
  }

  inspect(location: DocumentLocation): DocumentView {
    if (location.kind !== 'page') throw fail('A page view requires a page location.');
    const page = this.report.pages.find((item) => item.number === location.pageNumber);
    if (!page) throw fail(`Page not found: ${location.pageNumber}`);
    return { kind: 'page', pageNumber: page.number, width: page.widthPoints, height: page.heightPoints, svg: page.svg, warnings: page.warnings };
  }

  getPageText(pageNumber: number) {
    const cached = this.textCache.get(pageNumber);
    if (cached) return [...cached];
    const view = this.inspect({ kind: 'page', pageNumber });
    if (view.kind !== 'page') return [];
    const lines = extractSvgText(view.svg);
    this.textCache.set(pageNumber, lines);
    return [...lines];
  }

  getPositionedPageText(pageNumber: number) {
    const cached = this.positionedTextCache.get(pageNumber);
    if (cached) return [...cached];
    const lines = this.getPositionedPageTextBlocks(pageNumber).map((line) => `[x=${line.boundingBox.x.toFixed(3)}, y=${line.boundingBox.y.toFixed(3)}, w=${line.boundingBox.width.toFixed(3)}, h=${line.boundingBox.height.toFixed(3)}] ${line.text}`);
    this.positionedTextCache.set(pageNumber, lines);
    return [...lines];
  }

  getPositionedPageTextBlocks(pageNumber: number) {
    const cached = this.positionedTextBlocksCache.get(pageNumber);
    if (cached) return cached.map((line) => structuredClone(line));
    const view = this.inspect({ kind: 'page', pageNumber });
    if (view.kind !== 'page') return [];
    const blocks = extractPositionedTextBlocks(view.svg);
    this.positionedTextBlocksCache.set(pageNumber, blocks);
    return blocks.map((line) => structuredClone(line));
  }

  getPageHeadingCandidates(pageNumber: number) {
    if (this.report.sourceFormat.toLowerCase() !== 'pdf') return [];
    const cached = this.headingCandidatesCache.get(pageNumber);
    if (cached) return cached.map((candidate) => structuredClone(candidate));
    const view = this.inspect({ kind: 'page', pageNumber });
    if (view.kind !== 'page') return [];
    const textBlocks = this.positionedTextBlocksCache.get(pageNumber) ?? extractPositionedTextBlocks(view.svg);
    const candidates = inferPdfHeadingCandidates(textBlocks);
    this.headingCandidatesCache.set(pageNumber, candidates);
    return candidates.map((candidate) => structuredClone(candidate));
  }

  /** Geometric hints for text blocks sharing a visual row; these do not assert semantic table structure. */
  getPageTextRowHints(pageNumber: number) {
    return inferPageTextRowHints(this.getPositionedPageTextBlocks(pageNumber));
  }

  search(query: string, limit = 20): DocumentSearchResult[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length < 2) return [];
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    const results: DocumentSearchResult[] = [];
    for (const page of this.report.pages) {
      if (results.length >= boundedLimit) break;
      const lines = this.getPageText(page.number);
      for (const line of lines) {
        if (line.toLocaleLowerCase().includes(normalizedQuery)) {
          results.push({ location: { kind: 'page', pageNumber: page.number }, excerpt: line.slice(0, 300), matchType: 'text' });
          if (results.length >= boundedLimit) break;
        }
      }
    }
    return results;
  }

  annotate(annotation: DocumentAnnotationRecord) {
    if (this.documentId && annotation.documentId && annotation.documentId !== this.documentId) throw fail('Annotation belongs to a different document.', 409);
    const target = annotation.target;
    const pageNumber = target.kind === 'page' ? target.page : target.kind === 'slide' ? target.slide : 0;
    const expectedKind = this.report.sourceFormat.toLowerCase() === 'pptx' ? 'slide' : 'page';
    if (target.kind !== expectedKind || !Number.isInteger(pageNumber) || !this.report.pages.some((page) => page.number === pageNumber)) {
      throw fail('Annotation target does not exist in this paged document.');
    }
    const box = target.boundingBox;
    if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1) {
      throw fail('Annotation bounds must fit inside the normalized page.');
    }
    if (target.fragments?.length && (target.fragments.length > 32 || target.fragments.some((fragment) =>
      fragment.x < 0 || fragment.y < 0 || fragment.width <= 0 || fragment.height <= 0 || fragment.x + fragment.width > 1.001 || fragment.y + fragment.height > 1.001))) {
      throw fail('Annotation text fragments must fit inside the normalized page.');
    }
    if (target.textAnchor && (!target.textAnchor.quote.exact.trim() || target.textAnchor.quote.exact.length > 1000 ||
      !Number.isInteger(target.textAnchor.position.start) || !Number.isInteger(target.textAnchor.position.end) ||
      target.textAnchor.position.start < 0 || target.textAnchor.position.end < target.textAnchor.position.start ||
      target.textAnchor.position.unit !== 'normalized-page-text')) {
      throw fail('Annotation text selectors are invalid.');
    }
    const record = structuredClone(annotation);
    this.annotations.set(record.id, record);
    return structuredClone(record);
  }

  replaceAnnotations(annotations: DocumentAnnotationRecord[]) {
    const previous = new Map(this.annotations);
    this.annotations.clear();
    try {
      for (const annotation of annotations.slice(0, 2000)) this.annotate(annotation);
    } catch (error) {
      this.annotations.clear();
      for (const [id, annotation] of previous) this.annotations.set(id, annotation);
      throw error;
    }
  }

  listAnnotations() {
    return [...this.annotations.values()].map((annotation) => structuredClone(annotation));
  }

  removeAnnotation(annotationId: string) {
    return this.annotations.delete(annotationId);
  }

  async export(request: DocumentExportRequest): Promise<DocumentExportResult> {
    const sourceAnnotations = request.annotations ?? this.listAnnotations();
    const annotations = sourceAnnotations.filter((annotation) => ['auto', 'approved', 'corrected'].includes(annotation.status));
    const fileBase = this.fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 140) || 'document';
    if (request.format === 'annotations-json') {
      const sourceHash = sourceAnnotations.find((annotation) => annotation.sourceHash)?.sourceHash;
      const buffer = Buffer.from(JSON.stringify({ schemaVersion: 1, document: { documentId: this.documentId, fileName: this.fileName, fileType: this.report.sourceFormat, ...(sourceHash ? { sourceHash } : {}) }, documentAnnotations: sourceAnnotations }, null, 2));
      return { format: request.format, fileName: `${fileBase}-annotations.json`, contentType: 'application/json', buffer, annotationsExported: sourceAnnotations.length, skipped: [] };
    }
    if (request.format === 'annotations-csv') {
      return { format: request.format, fileName: `${fileBase}-annotations.csv`, contentType: 'text/csv; charset=utf-8', buffer: documentAnnotationsToCsv(sourceAnnotations), annotationsExported: sourceAnnotations.length, skipped: [] };
    }

    if (this.report.sourceFormat.toLowerCase() === 'docx') {
      const { exportWordComments } = await import('./wordCommentExporter');
      const confirmed = annotations.filter((annotation) => ['auto', 'approved', 'corrected'].includes(annotation.status));
      const result = await exportWordComments(this.sourceBufferRequired(), confirmed.map((annotation) => ({
        id: annotation.id,
        label: annotation.label,
        note: annotation.note ?? annotation.explanation,
        reason: annotation.reason ?? annotation.explanation,
        excerpt: annotation.excerpt ?? annotation.evidence,
        reviewPriority: annotation.reviewPriority,
        ...(annotation.target.kind !== 'sheet' && annotation.target.textAnchor ? { textAnchor: annotation.target.textAnchor } : {}),
      })));
      return {
        format: request.format,
        fileName: `${fileBase}-annotated.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: result.buffer,
        annotationsExported: result.annotationsAnchored,
        skipped: result.skipped.map((item) => ({ annotationId: item.annotationId, label: item.label, reason: item.reason })),
        metadata: { commentsAdded: result.commentsAdded, annotationsAnchored: result.annotationsAnchored },
      };
    }

    if (this.report.sourceFormat.toLowerCase() === 'pptx') {
      const { exportPowerPointAnnotations } = await import('./pptxAnnotationExporter');
      const confirmed = annotations.filter((annotation) => ['auto', 'approved', 'corrected'].includes(annotation.status));
      const result = await exportPowerPointAnnotations(this.sourceBufferRequired(), confirmed.flatMap((annotation) => {
        if (annotation.target.kind !== 'slide') return [];
        return [{
          id: annotation.id,
          pageNumber: annotation.target.slide,
          x: annotation.target.boundingBox.x,
          y: annotation.target.boundingBox.y,
          width: annotation.target.boundingBox.width,
          height: annotation.target.boundingBox.height,
          ...(annotation.target.fragments?.length ? { fragments: annotation.target.fragments } : {}),
          ...(annotation.target.textAnchor ? { textAnchor: annotation.target.textAnchor } : {}),
          label: annotation.label,
          note: annotation.note ?? '',
          reason: annotation.reason ?? annotation.explanation,
          excerpt: annotation.excerpt ?? annotation.evidence,
          reviewPriority: annotation.reviewPriority,
          color: annotation.color ?? '#278779',
          requiresReview: false,
          reviewedByHuman: annotation.status === 'approved' || annotation.status === 'corrected' || annotation.reviewedByHuman,
          reviewOutcome: annotation.status === 'approved' || annotation.status === 'corrected' ? annotation.status : undefined,
          source: annotation.source ?? 'ai',
        } satisfies Annotation];
      }));
      return {
        format: request.format,
        fileName: `${fileBase}-annotated.pptx`,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: result.buffer,
        annotationsExported: result.annotationsAdded,
        skipped: result.skipped.map((item) => ({ annotationId: item.annotationId, label: item.label, reason: item.reason })),
        metadata: { slidesModified: result.slidesModified, slidesTagged: result.slidesTagged, tagValuesWritten: result.tagValuesWritten },
      };
    }

    return this.exportAnnotatedPdf(annotations, fileBase);
  }

  private sourceBufferRequired(): Buffer {
    if (!this.sourceBuffer) throw fail('The original source document is not available in this session.', 410);
    return this.sourceBuffer;
  }

  private async exportAnnotatedPdf(annotations: DocumentAnnotationRecord[], fileBase: string): Promise<DocumentExportResult> {
    const { PDFDocument, StandardFonts, degrees, rgb } = await import('pdf-lib');
    const preserveSourcePdf = this.report.sourceFormat.toLowerCase() === 'pdf' && this.sourceBuffer !== undefined;
    const pdf = preserveSourcePdf
      ? await PDFDocument.load(Uint8Array.from(this.sourceBuffer!))
      : await PDFDocument.create();
    if (!preserveSourcePdf) {
      pdf.setTitle(`${this.fileName} · Annotated`);
      pdf.setAuthor('Annotation Studio');
    }
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let annotationsExported = 0;
    const skipped: DocumentExportResult['skipped'] = [];

    const sourcePages = preserveSourcePdf ? pdf.getPages() : [];
    for (const sourcePage of this.report.pages) {
      const pageNumber = sourcePage.number;
      let page: ReturnType<typeof pdf.getPage> | undefined;
      let visualWidth: number;
      let visualHeight: number;
      let rotation = 0;
      let toPdfRectangle: (box: { x: number; y: number; width: number; height: number }) => { x: number; y: number; width: number; height: number };
      let toPdfPoint: (x: number, yFromTop: number) => { x: number; y: number };

      if (preserveSourcePdf) {
        page = Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= sourcePages.length
          ? sourcePages[pageNumber - 1]
          : undefined;
        if (!page) {
          annotations.filter((annotation) =>
            (annotation.target.kind === 'page' ? annotation.target.page : annotation.target.kind === 'slide' ? annotation.target.slide : 0) === pageNumber)
            .forEach((annotation) => skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'source_page_missing' }));
          continue;
        }
        const crop = page.getCropBox();
        rotation = ((page.getRotation().angle % 360) + 360) % 360;
        const swapsDimensions = rotation === 90 || rotation === 270;
        visualWidth = swapsDimensions ? crop.height : crop.width;
        visualHeight = swapsDimensions ? crop.width : crop.height;
        toPdfRectangle = (box) => {
          switch (rotation) {
            case 90:
              return { x: crop.x + box.y * crop.width, y: crop.y + box.x * crop.height, width: box.height * crop.width, height: box.width * crop.height };
            case 180:
              return { x: crop.x + (1 - box.x - box.width) * crop.width, y: crop.y + box.y * crop.height, width: box.width * crop.width, height: box.height * crop.height };
            case 270:
              return { x: crop.x + (1 - box.y - box.height) * crop.width, y: crop.y + (1 - box.x - box.width) * crop.height, width: box.height * crop.width, height: box.width * crop.height };
            default:
              return { x: crop.x + box.x * crop.width, y: crop.y + (1 - box.y - box.height) * crop.height, width: box.width * crop.width, height: box.height * crop.height };
          }
        };
        toPdfPoint = (x, yFromTop) => {
          switch (rotation) {
            case 90: return { x: crop.x + yFromTop, y: crop.y + x };
            case 180: return { x: crop.x + crop.width - x, y: crop.y + yFromTop };
            case 270: return { x: crop.x + crop.width - yFromTop, y: crop.y + crop.height - x };
            default: return { x: crop.x + x, y: crop.y + crop.height - yFromTop };
          }
        };
      } else {
        visualWidth = Math.max(1, sourcePage.widthPoints);
        visualHeight = Math.max(1, sourcePage.heightPoints);
        page = pdf.addPage([visualWidth, visualHeight]);
        const png = await sharp(Buffer.from(sourcePage.svg)).png().toBuffer();
        const image = await pdf.embedPng(png);
        page.drawImage(image, { x: 0, y: 0, width: visualWidth, height: visualHeight });
        toPdfRectangle = (box) => ({
          x: box.x * visualWidth,
          y: visualHeight - (box.y + box.height) * visualHeight,
          width: box.width * visualWidth,
          height: box.height * visualHeight,
        });
        toPdfPoint = (x, yFromTop) => ({ x, y: visualHeight - yFromTop });
      }

      const marks = annotations.filter((annotation) =>
        (annotation.target.kind === 'page' ? annotation.target.page : annotation.target.kind === 'slide' ? annotation.target.slide : 0) === pageNumber);
      marks.forEach((annotation, index) => {
        const box = annotation.target.kind === 'page' || annotation.target.kind === 'slide' ? annotation.target.boundingBox : null;
        if (!box) { skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'invalid_target' }); return; }
        const colorValue = annotation.status === 'needs_review' ? 'E89A27' : annotation.color ?? '#278779';
        const match = colorValue.replace(/^#/, '').match(/^[0-9a-f]{6}$/i);
        const color = match ? rgb(Number.parseInt(match[0].slice(0, 2), 16) / 255, Number.parseInt(match[0].slice(2, 4), 16) / 255, Number.parseInt(match[0].slice(4, 6), 16) / 255) : rgb(0.09, 0.5, 0.47);
        const fragments = annotation.target.kind === 'page' || annotation.target.kind === 'slide'
          ? annotation.target.fragments?.length ? annotation.target.fragments : [box]
          : [box];
        fragments.forEach((fragment, fragmentIndex) => {
          const rect = toPdfRectangle(fragment);
          page!.drawRectangle({ x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height), borderColor: color, borderWidth: 1.5 });
          if (fragmentIndex === 0) {
            const tagX = fragment.x * visualWidth;
            const tagY = Math.min(visualHeight - 13, Math.max(0, fragment.y * visualHeight));
            const tag = toPdfRectangle({
              x: tagX / visualWidth,
              y: tagY / visualHeight,
              width: Math.min(15, visualWidth - tagX) / visualWidth,
              height: Math.min(13, visualHeight - tagY) / visualHeight,
            });
            page!.drawRectangle({ x: tag.x, y: tag.y, width: tag.width, height: tag.height, color });
            const markerPoint = toPdfPoint(tagX + 4, tagY + 10);
            page!.drawText(String(index + 1), { x: markerPoint.x, y: markerPoint.y, size: 8, font, color: rgb(1, 1, 1), rotate: degrees(-rotation) });
          }
        });
        appendPdfTextComment(page!, {
          id: annotation.id,
          label: annotation.label,
          note: annotation.note,
          explanation: annotation.reason ?? annotation.explanation,
          evidence: annotation.excerpt ?? annotation.evidence,
          status: annotation.status,
          reviewPriority: annotation.reviewPriority,
          rect: toPdfRectangle(fragments[0] ?? box),
          color,
        });
        annotationsExported += 1;
      });
    }
    const bytes = await pdf.save();
    const buffer = Buffer.from(bytes);
    return { format: 'native-annotated', fileName: `${fileBase}-annotated.pdf`, contentType: 'application/pdf', buffer, annotationsExported, skipped, metadata: { commentsAdded: annotationsExported } };
  }
}

export function searchDocumentAdapters(adapters: DocumentAdapter[], query: string, limit = 20) {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  return adapters.flatMap((adapter) => adapter.search(query, boundedLimit)).slice(0, boundedLimit);
}
