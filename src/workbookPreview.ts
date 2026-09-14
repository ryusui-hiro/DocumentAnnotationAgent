import type { SpreadsheetCellChange } from './types';

export function excelColumnIndex(value: string) {
  let result = 0;
  for (const letter of value.toUpperCase()) {
    result = result * 26 + letter.charCodeAt(0) - 64;
  }
  return result;
}

export function parseExcelCellAddress(value: string) {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(value.trim());
  if (!match) return null;
  return { column: excelColumnIndex(match[1]), row: Number(match[2]) };
}

export function spreadsheetChangeAtCell(changes: SpreadsheetCellChange[], sheetName: string, row: number, column: number) {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    if (change.sheetName !== sheetName) continue;
    const [startText, endText = startText] = change.range.split(':');
    const start = parseExcelCellAddress(startText);
    const end = parseExcelCellAddress(endText);
    if (!start || !end) continue;
    if (row < Math.min(start.row, end.row) || row > Math.max(start.row, end.row)
      || column < Math.min(start.column, end.column) || column > Math.max(start.column, end.column)) continue;
    const proposedValue = change.values[row - start.row]?.[column - start.column];
    if (proposedValue === undefined) continue;
    return { change, proposedValue };
  }
  return null;
}

export function excelColumnLetters(column: number) {
  let remaining = column;
  let label = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}

export function workbookColumnWindow(totalColumns: number, requestedStart: number, previewLimit = 80, windowSize = 16) {
  const available = Math.min(Math.max(1, Math.floor(totalColumns)), Math.max(1, Math.floor(previewLimit)));
  const size = Math.max(1, Math.floor(windowSize));
  const maximumStart = Math.max(1, Math.floor((available - 1) / size) * size + 1);
  const start = Math.min(Math.max(1, Math.floor(requestedStart)), maximumStart);
  return { available, start, end: Math.min(available, start + size - 1), size };
}

export function workbookColumnStartForCell(column: number, totalColumns: number, previewLimit = 80, windowSize = 16) {
  const { available, size } = workbookColumnWindow(totalColumns, 1, previewLimit, windowSize);
  const boundedColumn = Math.min(Math.max(1, Math.floor(column)), available);
  return Math.floor((boundedColumn - 1) / size) * size + 1;
}
