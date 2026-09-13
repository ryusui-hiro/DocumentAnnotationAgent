import type { PreviewReport } from 'document-svg';
import sharp from 'sharp';
import type { Annotation, DocumentAnnotationRecord } from '../src/types';
import { documentAnnotationsToCsv } from './annotationCsv';
import { extractPositionedTextLines } from './textTarget';

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
  pages?: Array<{ pageNumber: number; width: number; height: number; warningCount: number }>;
  sheets?: Array<{ name: string; rowCount: number; columnCount: number; headers: string[] }>;
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

export class PagedDocumentAdapter implements DocumentAdapter {
  private readonly textCache = new Map<number, string[]>();
  private readonly positionedTextCache = new Map<number, string[]>();
  private readonly annotations = new Map<string, DocumentAnnotationRecord>();

  constructor(readonly fileName: string, readonly report: PreviewReport, readonly documentId = '', private readonly sourceBuffer?: Buffer) {}

  getStructure(): DocumentOutline {
    return {
      fileName: this.fileName,
      fileType: this.report.sourceFormat,
      kind: 'paged',
      pageCount: this.report.pageCount,
      pages: this.report.pages.map((page) => ({ pageNumber: page.number, width: page.widthPoints, height: page.heightPoints, warningCount: page.warningCount })),
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
    const view = this.inspect({ kind: 'page', pageNumber });
    if (view.kind !== 'page') return [];
    const lines = extractPositionedTextLines(view.svg);
    this.positionedTextCache.set(pageNumber, lines);
    return [...lines];
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
      const buffer = Buffer.from(JSON.stringify({ schemaVersion: 1, document: { documentId: this.documentId, fileName: this.fileName, fileType: this.report.sourceFormat }, documentAnnotations: sourceAnnotations }, null, 2));
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
          label: annotation.label,
          note: annotation.note ?? '',
          reason: annotation.reason ?? annotation.explanation,
          excerpt: annotation.excerpt ?? annotation.evidence,
          reviewPriority: annotation.reviewPriority,
          color: annotation.color ?? '#278779',
          requiresReview: false,
          reviewedByHuman: annotation.status === 'corrected' || annotation.reviewedByHuman,
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
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.setTitle(`${this.fileName} · Annotated`);
    pdf.setAuthor('Annotation Studio');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let annotationsExported = 0;
    const skipped: DocumentExportResult['skipped'] = [];
    for (const sourcePage of this.report.pages) {
      const width = Math.max(1, sourcePage.widthPoints);
      const height = Math.max(1, sourcePage.heightPoints);
      const page = pdf.addPage([width, height]);
      const png = await sharp(Buffer.from(sourcePage.svg)).png().toBuffer();
      const image = await pdf.embedPng(png);
      page.drawImage(image, { x: 0, y: 0, width, height });
      const pageNumber = sourcePage.number;
      const marks = annotations.filter((annotation) => (annotation.target.kind === 'page' ? annotation.target.page : annotation.target.kind === 'slide' ? annotation.target.slide : 0) === pageNumber);
      marks.forEach((annotation, index) => {
        const box = annotation.target.kind === 'page' || annotation.target.kind === 'slide' ? annotation.target.boundingBox : null;
        if (!box) { skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'invalid_target' }); return; }
        const pending = annotation.status === 'needs_review';
        const colorValue = pending ? 'E89A27' : annotation.color ?? '#278779';
        const match = colorValue.replace(/^#/, '').match(/^[0-9a-f]{6}$/i);
        const color = match ? rgb(Number.parseInt(match[0].slice(0, 2), 16) / 255, Number.parseInt(match[0].slice(2, 4), 16) / 255, Number.parseInt(match[0].slice(4, 6), 16) / 255) : rgb(0.09, 0.5, 0.47);
        const x = box.x * width;
        const y = height - (box.y + box.height) * height;
        page.drawRectangle({ x, y, width: Math.max(1, box.width * width), height: Math.max(1, box.height * height), borderColor: color, borderWidth: 1.5 });
        const tagY = Math.min(height - 13, Math.max(0, height - box.y * height - 13));
        page.drawRectangle({ x, y: tagY, width: 15, height: 13, color });
        page.drawText(String(index + 1), { x: x + 4, y: tagY + 3, size: 8, font, color: rgb(1, 1, 1) });
        annotationsExported += 1;
      });
    }
    const bytes = await pdf.save();
    const buffer = Buffer.from(bytes);
    return { format: 'native-annotated', fileName: `${fileBase}-annotated.pdf`, contentType: 'application/pdf', buffer, annotationsExported, skipped };
  }
}

export function searchDocumentAdapters(adapters: DocumentAdapter[], query: string, limit = 20) {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  return adapters.flatMap((adapter) => adapter.search(query, boundedLimit)).slice(0, boundedLimit);
}
