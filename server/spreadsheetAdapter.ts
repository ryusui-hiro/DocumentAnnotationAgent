import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { DocumentAdapter, DocumentExportRequest, DocumentExportResult, DocumentLocation, DocumentOutline, DocumentSearchResult, DocumentView, SpreadsheetInspector } from './documentAdapter';
import type { DocumentAnnotationRecord } from '../src/types';
import { documentAnnotationsToCsv } from './annotationCsv';

const maxRangeCells = 500;
const maxWorkbookRows = 1_000_000;
const maxWorkbookColumns = 16_384;
const spreadsheetDrawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

function prefixDefaultSpreadsheetDrawingElements(xml: string) {
  if (!xml.includes('<wsDr') || !xml.includes(`xmlns="${spreadsheetDrawingNamespace}"`)) return xml;
  let output = '';
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open < 0) return output + xml.slice(cursor);
    output += xml.slice(cursor, open);
    const specialTerminator = xml.startsWith('<!--', open) ? '-->'
      : xml.startsWith('<![CDATA[', open) ? ']]>'
        : xml.startsWith('<?', open) ? '?>'
          : '';
    if (specialTerminator) {
      const terminatorIndex = xml.indexOf(specialTerminator, open);
      if (terminatorIndex < 0) return output + xml.slice(open);
      const specialEnd = terminatorIndex + specialTerminator.length;
      output += xml.slice(open, specialEnd);
      cursor = specialEnd;
      continue;
    }
    let end = open + 1;
    let quote = '';
    for (; end < xml.length; end += 1) {
      const character = xml[end]!;
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= xml.length) return output + xml.slice(open);
    const tag = xml.slice(open, end + 1);
    if (tag.startsWith('<!')) {
      output += tag;
      cursor = end + 1;
      continue;
    }
    let nameStart = open + 1 + (xml[open + 1] === '/' ? 1 : 0);
    let nameEnd = nameStart;
    while (nameEnd < end && !/[\s/>]/u.test(xml[nameEnd]!)) nameEnd += 1;
    const name = xml.slice(nameStart, nameEnd);
    const prefix = name && !name.includes(':') ? `xdr:${name}` : name;
    const normalizedTag = `${xml.slice(open, nameStart)}${prefix}${xml.slice(nameEnd, end)}`
      .replaceAll(`xmlns="${spreadsheetDrawingNamespace}"`, `xmlns:xdr="${spreadsheetDrawingNamespace}"`)
      + '>';
    output += normalizedTag;
    cursor = end + 1;
  }
  return output;
}

async function exceljsCompatibleWorkbook(buffer: Buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    let changed = false;
    const drawings = Object.keys(zip.files).filter((name) => name.startsWith('xl/drawings/') && name.endsWith('.xml') && !name.includes('/_rels/'));
    for (const name of drawings) {
      const file = zip.file(name);
      if (!file) continue;
      const original = await file.async('string');
      const normalized = prefixDefaultSpreadsheetDrawingElements(original);
      if (normalized !== original) {
        zip.file(name, normalized);
        changed = true;
      }
    }
    return changed ? Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })) : buffer;
  } catch {
    return buffer;
  }
}

export type SpreadsheetValue = string | number | boolean | null;

export interface SpreadsheetCellChange {
  id: string;
  operation: 'write_cell' | 'write_range' | 'create_column';
  sheetName: string;
  range: string;
  values: SpreadsheetValue[][];
  reason: string;
  confidence?: number;
  reviewPriority?: 'low' | 'medium' | 'high';
  requiresReview: boolean;
  approved?: boolean;
  rejected?: boolean;
}

function fail(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function normalizeValue(value: unknown): SpreadsheetValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' && item && 'text' in item ? String(item.text) : '').join('');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.formula === 'string') return record.result === undefined ? `=${record.formula}` : normalizeValue(record.result);
    if (record.result !== undefined) return normalizeValue(record.result);
    if (typeof record.text === 'string') return record.text;
    if (typeof record.hyperlink === 'string') return String(record.text ?? record.hyperlink);
    return JSON.stringify(record).slice(0, 2000);
  }
  return String(value).slice(0, 2000);
}

function parseCellAddress(address: string) {
  const match = address.trim().toUpperCase().match(/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/);
  if (!match) throw fail(`Invalid Excel cell address: ${address}`);
  let column = 0;
  for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (row > maxWorkbookRows || column > maxWorkbookColumns) throw fail('Cell address is outside Excel worksheet limits.');
  return { row, column };
}

function cellAddress(row: number, column: number) {
  let value = column;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return `${letters}${row}`;
}

function parseRange(range: string) {
  const parts = range.trim().toUpperCase().split(':');
  if (parts.length < 1 || parts.length > 2) throw fail('Use a single cell or a rectangular range such as A1:D20.');
  const start = parseCellAddress(parts[0]!);
  const end = parseCellAddress(parts[1] ?? parts[0]!);
  if (end.row < start.row || end.column < start.column) throw fail('Range endpoints must be ordered from top-left to bottom-right.');
  const count = (end.row - start.row + 1) * (end.column - start.column + 1);
  if (count > maxRangeCells) throw fail(`A range may contain at most ${maxRangeCells} cells.`, 413);
  return { start, end, count };
}

export class SpreadsheetDocumentAdapter implements DocumentAdapter, SpreadsheetInspector {
  private constructor(readonly workbook: ExcelJS.Workbook, readonly fileName: string, readonly documentId = '') {}
  private readonly changes = new Map<string, SpreadsheetCellChange>();
  private readonly annotations = new Map<string, DocumentAnnotationRecord>();

  static async fromBuffer(fileName: string, buffer: Buffer, documentId = '') {
    let workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as never);
    } catch {
      const compatible = await exceljsCompatibleWorkbook(buffer);
      if (compatible === buffer) throw fail('XLSX workbook could not be opened. It may be encrypted or corrupted.', 415);
      workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(compatible as never);
      } catch {
        throw fail('XLSX workbook could not be opened. It may be encrypted or corrupted.', 415);
      }
    }
    return new SpreadsheetDocumentAdapter(workbook, fileName, documentId);
  }

  static async fromSavedState(fileName: string, buffer: Buffer, changes: SpreadsheetCellChange[], documentId = '') {
    const adapter = await SpreadsheetDocumentAdapter.fromBuffer(fileName, buffer, documentId);
    for (const change of changes) {
      adapter.changes.set(change.id, { ...change, values: change.values.map((row) => [...row]) });
      adapter.annotations.set(change.id, adapter.annotationFromChange(change));
    }
    return adapter;
  }

  annotate(annotation: DocumentAnnotationRecord) {
    if (annotation.documentId && this.documentId && annotation.documentId !== this.documentId) throw fail('Annotation belongs to a different workbook.', 409);
    if (annotation.target.kind !== 'sheet' || (annotation.operation !== 'write_cell' && annotation.operation !== 'write_range' && annotation.operation !== 'create_column')) {
      throw fail('Workbook annotations must target a cell range and define a supported cell operation.');
    }
    const worksheet = this.getWorksheet(annotation.target.sheet);
    const values = annotation.values?.map((row) => row.map(normalizeValue)) ?? [];
    const reason = (annotation.reason || annotation.explanation).slice(0, 500);
    const status = annotation.status;
    const requiresReview = Boolean(annotation.requiresReview) || status === 'needs_review';
    const rejected = Boolean(annotation.rejected) || status === 'rejected';
    const approved = !requiresReview && !rejected;
    let change: SpreadsheetCellChange;
    if (annotation.operation === 'write_range') {
      const startText = annotation.target.cellRange.split(':')[0]!;
      const start = parseCellAddress(startText);
      if (!values.length || values.length > 100 || values.some((row) => !row.length || row.length > 50)) throw fail('Range values must be a non-empty matrix of at most 100 × 50 cells.');
      const cellCount = values.reduce((sum, row) => sum + row.length, 0);
      if (cellCount > maxRangeCells || start.row + values.length - 1 > maxWorkbookRows || start.column + Math.max(...values.map((row) => row.length)) - 1 > maxWorkbookColumns) throw fail(`A write range may contain at most ${maxRangeCells} cells and must fit within Excel limits.`, 413);
      const end = cellAddress(start.row + values.length - 1, start.column + Math.max(...values.map((row) => row.length)) - 1);
      change = this.recordChange({
        operation: 'write_range', sheetName: worksheet.name, range: `${cellAddress(start.row, start.column)}:${end}`, values, reason,
        confidence: annotation.confidence, reviewPriority: annotation.reviewPriority, requiresReview,
        ...(approved ? { approved: true } : {}),
      }, annotation.id);
      if (approved) this.applyChange(change);
    } else {
      const cell = parseCellAddress(annotation.target.cellRange);
      const value = values[0]?.[0];
      if (value === undefined) throw fail('Cell annotations must provide exactly one value.');
      if (annotation.operation === 'create_column' && (typeof value !== 'string' || !value.trim() || value.length > 120)) throw fail('Column headers must contain 1 to 120 characters.');
      change = this.recordChange({
        operation: annotation.operation, sheetName: worksheet.name, range: cellAddress(cell.row, cell.column), values: [[value]], reason,
        confidence: annotation.confidence, reviewPriority: annotation.reviewPriority, requiresReview,
        ...(approved ? { approved: true } : {}),
      }, annotation.id);
      if (approved) this.applyChange(change);
    }
    if (rejected) {
      change = { ...change, rejected: true };
      this.changes.set(change.id, change);
    }
    const stored = this.annotationFromChange(change);
    this.annotations.set(stored.id, stored);
    return structuredClone(stored);
  }

  replaceAnnotations(annotations: DocumentAnnotationRecord[]) {
    this.annotations.clear();
    for (const annotation of annotations.slice(0, 2000)) this.annotate(annotation);
  }

  listAnnotations() {
    return [...this.annotations.values()].map((annotation) => structuredClone(annotation));
  }

  removeAnnotation(annotationId: string) {
    const change = this.changes.get(annotationId);
    if (change?.approved) return false;
    this.annotations.delete(annotationId);
    return change ? this.changes.delete(annotationId) : false;
  }

  async export(request: DocumentExportRequest): Promise<DocumentExportResult> {
    const annotations = request.annotations ?? this.listAnnotations();
    const baseName = this.fileName.replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 140) || 'workbook';
    if (request.format === 'annotations-json') {
      const buffer = Buffer.from(JSON.stringify({ schemaVersion: 1, document: { documentId: this.documentId, fileName: this.fileName, fileType: 'XLSX' }, documentAnnotations: annotations }, null, 2));
      return { format: request.format, fileName: `${baseName}-annotations.json`, contentType: 'application/json', buffer, annotationsExported: annotations.length, skipped: [] };
    }
    if (request.format === 'annotations-csv') {
      return { format: request.format, fileName: `${baseName}-annotations.csv`, contentType: 'text/csv; charset=utf-8', buffer: documentAnnotationsToCsv(annotations), annotationsExported: annotations.length, skipped: [] };
    }
    const buffer = await this.writeBuffer();
    const exported = this.getChanges().filter((change) => change.approved && !change.rejected).length;
    return { format: request.format, fileName: `${baseName}-annotated.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer, annotationsExported: exported, skipped: [] };
  }

  listSheets() {
    return this.workbook.worksheets.slice(0, 50).map((worksheet) => this.inspectSheet(worksheet.name));
  }

  getStructure(): DocumentOutline {
    return {
      fileName: this.fileName,
      fileType: 'XLSX',
      kind: 'spreadsheet',
      sheets: this.listSheets().map(({ name, rowCount, columnCount, headers }) => ({ name, rowCount, columnCount, headers })),
    };
  }

  inspect(location: DocumentLocation): DocumentView {
    if (location.kind !== 'sheet') throw fail('A workbook view requires a worksheet location.');
    if (location.range) {
      const result = this.readRange(location.sheetName, location.range);
      return { kind: 'range', sheetName: result.sheetName, range: result.range, rows: result.rows, cellCount: result.cellCount };
    }
    return { kind: 'sheet', sheetName: location.sheetName, summary: this.inspectSheet(location.sheetName) };
  }

  search(query: string, limit = 20): DocumentSearchResult[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length < 2) return [];
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    const maxSearchCells = 100_000;
    const maxSearchRowsPerSheet = 10_000;
    const results: DocumentSearchResult[] = [];
    let visitedCells = 0;
    let stopped = false;
    for (const worksheet of this.workbook.worksheets.slice(0, 50)) {
      if (results.length >= boundedLimit || visitedCells >= maxSearchCells) break;
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (stopped || rowNumber > maxSearchRowsPerSheet || results.length >= boundedLimit || visitedCells >= maxSearchCells) { stopped = true; return; }
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (stopped || results.length >= boundedLimit || visitedCells >= maxSearchCells) { stopped = true; return; }
          visitedCells += 1;
          const value = normalizeValue(cell.value);
          if (value !== null && String(value).toLocaleLowerCase().includes(normalizedQuery)) {
            results.push({ location: { kind: 'sheet', sheetName: worksheet.name, range: cell.address }, excerpt: String(value).slice(0, 300), matchType: 'cell' });
          }
        });
      });
      stopped = false;
    }
    return results;
  }

  inspectSheet(sheetName: string) {
    const worksheet = this.getWorksheet(sheetName);
    const rowCount = Math.min(worksheet.rowCount, maxWorkbookRows);
    const columnCount = Math.min(worksheet.columnCount, maxWorkbookColumns);
    const headers = Array.from({ length: Math.min(columnCount, 80) }, (_, index) => normalizeValue(worksheet.getRow(1).getCell(index + 1).value) ?? '').map(String);
    const sampleRows = Array.from({ length: Math.min(Math.max(0, rowCount - 1), 20) }, (_, index) => {
      const rowNumber = index + 2;
      return {
        rowNumber,
        values: Array.from({ length: Math.min(columnCount, 80) }, (_, columnIndex) => normalizeValue(worksheet.getRow(rowNumber).getCell(columnIndex + 1).value)),
      };
    });
    return { name: worksheet.name, rowCount, columnCount, headers, sampleRows };
  }

  readRange(sheetName: string, range: string) {
    const worksheet = this.getWorksheet(sheetName);
    const parsed = parseRange(range);
    const rows = [];
    for (let row = parsed.start.row; row <= parsed.end.row; row += 1) {
      const values = [];
      for (let column = parsed.start.column; column <= parsed.end.column; column += 1) {
        const cell = worksheet.getCell(row, column);
        values.push({ address: cellAddress(row, column), value: normalizeValue(cell.value) });
      }
      rows.push(values);
    }
    return { sheetName: worksheet.name, range: `${cellAddress(parsed.start.row, parsed.start.column)}:${cellAddress(parsed.end.row, parsed.end.column)}`, rows, cellCount: parsed.count };
  }

  createColumn(sheetName: string, header: string, headerRow: number, reason = 'Created by the document agent.', options: { requiresReview?: boolean; id?: string } = {}) {
    const worksheet = this.getWorksheet(sheetName);
    if (!header.trim() || header.length > 120) throw fail('Column header must contain 1 to 120 characters.');
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > maxWorkbookRows) throw fail('Header row is outside the supported worksheet range.');
    const row = worksheet.getRow(headerRow);
    const address = this.nextEmptyColumnAddress(sheetName, headerRow);
    if (!options.requiresReview) row.getCell(parseCellAddress(address).column).value = header.trim();
    return this.recordChange({ operation: 'create_column', sheetName: worksheet.name, range: address, values: [[header.trim()]], reason, requiresReview: Boolean(options.requiresReview), ...(options.requiresReview ? {} : { approved: true }) }, options.id);
  }

  nextEmptyColumnAddress(sheetName: string, headerRow: number) {
    const worksheet = this.getWorksheet(sheetName);
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > maxWorkbookRows) throw fail('Header row is outside the supported worksheet range.');
    const row = worksheet.getRow(headerRow);
    let column = Math.max(1, worksheet.columnCount) + 1;
    for (let index = 1; index <= Math.min(maxWorkbookColumns, worksheet.columnCount + 1); index += 1) {
      if (normalizeValue(row.getCell(index).value) === null) { column = index; break; }
    }
    if (column > maxWorkbookColumns) throw fail('The worksheet has no available column.');
    return cellAddress(headerRow, column);
  }

  writeCell(sheetName: string, address: string, value: SpreadsheetValue, reason: string, confidence: number | undefined, requiresReview: boolean, id?: string) {
    const worksheet = this.getWorksheet(sheetName);
    const parsed = parseCellAddress(address);
    if (!requiresReview) worksheet.getCell(parsed.row, parsed.column).value = value;
    return this.recordChange({ operation: 'write_cell', sheetName: worksheet.name, range: cellAddress(parsed.row, parsed.column), values: [[value]], reason, confidence, requiresReview, ...(!requiresReview ? { approved: true } : {}) }, id);
  }

  writeRange(sheetName: string, startAddress: string, values: Array<Array<SpreadsheetValue>>, reason: string, confidence: number | undefined, requiresReview: boolean, id?: string) {
    const worksheet = this.getWorksheet(sheetName);
    if (!values.length || values.length > 100 || values.some((row) => !row.length || row.length > 50)) throw fail('Range values must be a non-empty matrix of at most 100 × 50 cells.');
    const start = parseCellAddress(startAddress);
    const cellCount = values.reduce((total, row) => total + row.length, 0);
    if (cellCount > maxRangeCells || start.row + values.length - 1 > maxWorkbookRows || start.column + Math.max(...values.map((row) => row.length)) - 1 > maxWorkbookColumns) {
      throw fail(`A write range may contain at most ${maxRangeCells} cells and must fit within Excel limits.`, 413);
    }
    if (!requiresReview) values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      worksheet.getCell(start.row + rowIndex, start.column + columnIndex).value = value;
    }));
    const end = cellAddress(start.row + values.length - 1, start.column + Math.max(...values.map((row) => row.length)) - 1);
    return this.recordChange({ operation: 'write_range', sheetName: worksheet.name, range: `${cellAddress(start.row, start.column)}:${end}`, values, reason, confidence, requiresReview, ...(!requiresReview ? { approved: true } : {}) }, id);
  }

  getChanges() {
    return [...this.changes.values()].map((change) => ({ ...change, values: change.values.map((row) => [...row]) }));
  }

  approveChange(changeId: string) {
    const change = this.changes.get(changeId);
    if (!change) throw fail('Spreadsheet change not found.', 404);
    if (change.rejected) throw fail('A rejected spreadsheet change cannot be approved.', 409);
    if (change.approved) return change;
    this.applyChange(change);
    const approved = { ...change, requiresReview: false, approved: true };
    this.changes.set(changeId, approved);
    this.annotations.set(changeId, this.annotationFromChange(approved));
    return approved;
  }

  rejectChange(changeId: string) {
    const change = this.changes.get(changeId);
    if (!change) throw fail('Spreadsheet change not found.', 404);
    if (change.approved) throw fail('An approved spreadsheet change cannot be rejected.', 409);
    const rejected = { ...change, rejected: true };
    this.changes.set(changeId, rejected);
    this.annotations.set(changeId, this.annotationFromChange(rejected));
    return rejected;
  }

  async writeBuffer() {
    const result = await this.workbook.xlsx.writeBuffer();
    return Buffer.from(result);
  }

  private getWorksheet(sheetName: string) {
    const worksheet = this.workbook.getWorksheet(sheetName);
    if (!worksheet) throw fail(`Worksheet not found: ${sheetName}`, 404);
    return worksheet;
  }

  private recordChange(change: Omit<SpreadsheetCellChange, 'id'>, id?: string): SpreadsheetCellChange {
    const result = { id: id ?? `cell-${randomUUID()}`, ...change };
    this.changes.set(result.id, result);
    this.annotations.set(result.id, this.annotationFromChange(result));
    return result;
  }

  private annotationFromChange(change: SpreadsheetCellChange): DocumentAnnotationRecord {
    const status = change.rejected ? 'rejected' : change.requiresReview ? 'needs_review' : change.approved ? 'approved' : 'auto';
    const label = change.operation === 'create_column' ? `Create column: ${String(change.values[0]?.[0] ?? '')}` : 'Workbook cell update';
    return {
      id: change.id,
      documentId: this.documentId,
      target: { kind: 'sheet', sheet: change.sheetName, cellRange: change.range },
      label,
      evidence: JSON.stringify(change.values),
      explanation: change.reason,
      reviewPriority: change.reviewPriority ?? (status === 'needs_review' ? 'high' : 'medium'),
      status,
      ...(change.confidence !== undefined ? { confidence: change.confidence } : {}),
      note: change.reason,
      reason: change.reason,
      operation: change.operation,
      values: change.values.map((row) => [...row]),
      requiresReview: change.requiresReview,
      approved: Boolean(change.approved),
      rejected: Boolean(change.rejected),
    };
  }

  private applyChange(change: SpreadsheetCellChange) {
    const worksheet = this.getWorksheet(change.sheetName);
    if (change.operation === 'create_column' || change.operation === 'write_cell') {
      const cell = parseCellAddress(change.range);
      worksheet.getCell(cell.row, cell.column).value = change.values[0]?.[0] ?? null;
      return;
    }
    const start = parseCellAddress(change.range.split(':')[0]!);
    change.values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      worksheet.getCell(start.row + rowIndex, start.column + columnIndex).value = value;
    }));
  }
}
