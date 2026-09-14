import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpreadsheetCellChange } from './types';
import { excelColumnIndex, excelColumnLetters, parseExcelCellAddress, spreadsheetChangeAtCell, workbookColumnStartForCell, workbookColumnWindow } from './workbookPreview';

test('Excel preview converts column letters and absolute cell addresses', () => {
  assert.equal(excelColumnIndex('Z'), 26);
  assert.equal(excelColumnIndex('AA'), 27);
  assert.equal(excelColumnLetters(1), 'A');
  assert.equal(excelColumnLetters(27), 'AA');
  assert.deepEqual(parseExcelCellAddress('$AA$12'), { column: 27, row: 12 });
  assert.equal(parseExcelCellAddress('not-a-cell'), null);
});

test('Excel preview resolves range proposals by sheet and shows the latest overlapping change', () => {
  const changes: SpreadsheetCellChange[] = [
    { id: 'older', operation: 'write_range', sheetName: 'Customers', range: 'B2:C3', values: [['2026-10-01', 8400], ['2026-11-15', 1200]], reason: 'Earlier proposal', requiresReview: true },
    { id: 'newer', operation: 'write_cell', sheetName: 'Customers', range: 'C3', values: [[1500]], reason: 'Updated proposal', requiresReview: true },
  ];

  assert.equal(spreadsheetChangeAtCell(changes, 'Customers', 2, 2)?.proposedValue, '2026-10-01');
  assert.equal(spreadsheetChangeAtCell(changes, 'Customers', 3, 3)?.change.id, 'newer');
  assert.equal(spreadsheetChangeAtCell(changes, 'Customers', 3, 3)?.proposedValue, 1500);
  assert.equal(spreadsheetChangeAtCell(changes, 'Other', 3, 3), null);
  assert.equal(spreadsheetChangeAtCell(changes, 'Customers', 4, 3), null);
});

test('Excel preview does not mark a missing entry in a ragged range as a proposed blank value', () => {
  const change: SpreadsheetCellChange = {
    id: 'ragged-range', operation: 'write_range', sheetName: 'Customers', range: 'A1:B2',
    values: [['Name', 'Risk'], ['Aki']], reason: 'Fill only the cells that have values.', requiresReview: true,
  };
  assert.equal(spreadsheetChangeAtCell([change], 'Customers', 2, 1)?.proposedValue, 'Aki');
  assert.equal(spreadsheetChangeAtCell([change], 'Customers', 2, 2), null);
});

test('Excel preview windows page through wide sheets and clamp when a smaller workbook is opened', () => {
  assert.deepEqual(workbookColumnWindow(200, 1), { available: 80, start: 1, end: 16, size: 16 });
  assert.deepEqual(workbookColumnWindow(200, 65), { available: 80, start: 65, end: 80, size: 16 });
  assert.deepEqual(workbookColumnWindow(10, 65), { available: 10, start: 1, end: 10, size: 16 });
  assert.equal(workbookColumnStartForCell(27, 200), 17);
  assert.equal(workbookColumnStartForCell(120, 200), 65);
});
