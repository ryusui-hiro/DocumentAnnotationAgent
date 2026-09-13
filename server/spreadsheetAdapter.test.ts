import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SpreadsheetDocumentAdapter } from './spreadsheetAdapter';

async function createSourceWorkbook(withTitleRows = false) {
  const workbook = new ExcelJS.Workbook();
  const customers = workbook.addWorksheet('Customers');
  customers.addRows([
    ...(withTitleRows ? [['Customer churn review'], ['Internal use only']] : []),
    ['Name', 'Last login', 'Tickets'],
    ['Aki', '2026-09-01', 0],
    ['Mina', '2026-01-05', 8],
  ]);
  workbook.addWorksheet('Notes').getCell('A1').value = 'Keep this sheet';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('opens workbook outline, inspects sheets, and reads bounded cell ranges', async () => {
  const source = await createSourceWorkbook();
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);

  assert.equal(adapter.open().fileName, 'customers.xlsx');
  assert.equal(adapter.getStructure().kind, 'spreadsheet');
  assert.equal(adapter.inspect({ kind: 'sheet', sheetName: 'Customers' }).kind, 'sheet');
  const sheets = adapter.listSheets();
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0]?.name, 'Customers');
  assert.deepEqual(sheets[0]?.headers.slice(0, 3), ['Name', 'Last login', 'Tickets']);
  assert.deepEqual(sheets[0]?.sampleRows[1]?.values.slice(0, 3), ['Mina', '2026-01-05', 8]);
  assert.deepEqual(adapter.readRange('Customers', 'A1:B2').rows, [
    [{ address: 'A1', value: 'Name' }, { address: 'B1', value: 'Last login' }],
    [{ address: 'A2', value: 'Aki' }, { address: 'B2', value: '2026-09-01' }],
  ]);
  assert.throws(() => adapter.readRange('Customers', 'A1:Z30'), /at most 500 cells/);
  assert.throws(() => adapter.readRange('Unknown', 'A1'), /Worksheet not found/);
  assert.deepEqual(adapter.search('Mina')[0]?.location, { kind: 'sheet', sheetName: 'Customers', range: 'A3' });
});

test('separates automatic application from human review outcomes in canonical workbook records', async () => {
  const source = await createSourceWorkbook();
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);
  const automatic = adapter.writeCell('Customers', 'D2', 'LOW', 'Automatically applied low-risk value.', undefined, false, 'auto-cell');
  const pending = adapter.writeCell('Customers', 'D3', 'HIGH', 'Needs human confirmation.', undefined, true, 'pending-cell');
  const rejected = adapter.writeCell('Customers', 'D4', 'HIGH', 'Unsupported result.', undefined, true, 'rejected-cell');
  adapter.rejectChange(rejected.id);

  const automaticRecord = adapter.listAnnotations().find((annotation) => annotation.id === automatic.id);
  const pendingBefore = adapter.listAnnotations().find((annotation) => annotation.id === pending.id);
  const rejectedRecord = adapter.listAnnotations().find((annotation) => annotation.id === rejected.id);
  assert.equal(automaticRecord?.status, 'auto');
  assert.equal(automaticRecord?.approved, true, 'approved remains the operational flag that the cell value is applied');
  assert.equal(pendingBefore?.status, 'needs_review');
  assert.equal(rejectedRecord?.status, 'rejected');

  adapter.approveChange(pending.id);
  assert.equal(adapter.listAnnotations().find((annotation) => annotation.id === pending.id)?.status, 'approved');

  const corrected = adapter.annotate({
    id: 'corrected-cell', documentId: '', target: { kind: 'sheet', sheet: 'Customers', cellRange: 'D5' },
    label: 'Workbook cell update', evidence: '[["MEDIUM"]]', explanation: 'Human changed the proposed value.',
    reviewPriority: 'medium', status: 'corrected', operation: 'write_cell', values: [['MEDIUM']], reason: 'Human changed the proposed value.', requiresReview: false,
  });
  assert.equal(corrected.status, 'corrected');
});

test('canonical spreadsheet status overrides stale operational and review flags', async () => {
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', await createSourceWorkbook());
  const imported = adapter.annotate({
    id: 'canonical-auto', documentId: '', target: { kind: 'sheet', sheet: 'Customers', cellRange: 'D6' },
    label: 'Workbook cell update', evidence: '["AUTO"]', explanation: 'Automatically applied.',
    reviewPriority: 'high', status: 'auto', note: 'Automatically applied.', reason: 'Automatically applied.',
    operation: 'write_cell', values: [['AUTO']], requiresReview: true, approved: false, rejected: true,
  });
  assert.equal(imported.status, 'auto');
  assert.equal(imported.requiresReview, false);
  assert.equal(imported.approved, true, 'the automatic cell write stays operationally applied');
  assert.equal(imported.rejected, false);
  assert.deepEqual(adapter.readRange('Customers', 'D6').rows[0]?.[0], { address: 'D6', value: 'AUTO' });
});

test('supports a table header row beyond the initial preview sample', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Details');
  sheet.getCell('A21').value = 'Name';
  sheet.getCell('A22').value = 'Mina';
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('details.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const change = adapter.createColumn('Details', 'Review', 21, 'Add a result beside the table header.', { requiresReview: false });
  assert.equal(change.range, 'B21');
  assert.equal(adapter.readRange('Details', 'B21').rows[0]?.[0]?.value, 'Review');
});

test('reserves pending columns and sizes Japanese headers by their rendered width', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Review').addRow(['ID', 'Value']);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('review.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const first = adapter.createColumn('Review', 'Risk', 1, 'First review column.', { requiresReview: true, id: 'risk-column' });
  const japanese = adapter.createColumn('Review', '日本語レビュー', 1, 'Japanese review column.', { requiresReview: true, id: 'japanese-column' });
  const longHeader = adapter.createColumn('Review', '日本語'.repeat(25), 1, 'Long Japanese header.', { requiresReview: true, id: 'long-japanese-column' });

  assert.equal(first.range, 'C1');
  assert.equal(japanese.range, 'D1');
  assert.equal(longHeader.range, 'E1');
  assert.equal(adapter.readRange('Review', 'C1:E1').rows[0]?.map((cell) => cell.value).join(','), ',,');

  adapter.approveChange(first.id);
  adapter.approveChange(japanese.id);
  adapter.approveChange(longHeader.id);
  const sheet = adapter.workbook.getWorksheet('Review');
  assert.equal(adapter.readRange('Review', 'C1:E1').rows[0]?.map((cell) => cell.value).join(','), `Risk,${'日本語レビュー'},${'日本語'.repeat(25)}`);
  assert.ok((sheet?.getColumn(4).width ?? 0) >= 16, 'full-width Japanese characters need about two Excel width units each');
  assert.equal(sheet?.getColumn(5).width, 40);
  assert.equal(sheet?.getCell('E1').alignment?.wrapText, true);
  assert.ok((sheet?.getRow(1).height ?? 0) >= 60, 'row height should account for wrapped full-width text');
});

test('stages cell and column edits at the selected table header row, applies only approved changes, and exports a separate workbook', async () => {
  const source = await createSourceWorkbook(true);
  const untouchedSource = Buffer.from(source);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);

  const riskColumn = adapter.createColumn('Customers', 'Churn Risk', 3, 'Classify each customer.', { requiresReview: true, id: 'proposal-column' });
  assert.equal(riskColumn.range, 'D3');
  assert.equal(adapter.readRange('Customers', 'D3').rows[0]?.[0]?.value, null);
  adapter.approveChange(riskColumn.id);
  assert.equal(adapter.readRange('Customers', 'A1').rows[0]?.[0]?.value, 'Customer churn review');
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, null);
  assert.equal(adapter.readRange('Customers', 'D3').rows[0]?.[0]?.value, 'Churn Risk');
  assert.ok((adapter.workbook.getWorksheet('Customers')?.getColumn(4).width ?? 0) >= 'Churn Risk'.length + 2);

  const rejected = adapter.writeCell('Customers', 'D4', 'LOW', 'Aki has no support tickets.', 0.96, true, 'rejected-cell');
  adapter.rejectChange(rejected.id);
  assert.equal(adapter.readRange('Customers', 'D4').rows[0]?.[0]?.value, null);

  const accepted = adapter.writeRange('Customers', 'D4', [['LOW'], ['HIGH']], 'Risk classification based on activity.', 0.91, true, 'approved-range');
  adapter.approveChange(accepted.id);
  assert.deepEqual(adapter.readRange('Customers', 'D4:D5').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
  assert.equal(adapter.getChanges().find((change) => change.id === 'approved-range')?.approved, true);
  assert.equal(adapter.getChanges().find((change) => change.id === 'rejected-cell')?.rejected, true);

  const exportResult = await adapter.export({ format: 'native-annotated' });
  const exported = exportResult.buffer;
  assert.equal(exportResult.fileName, 'customers-annotated.xlsx');
  assert.equal(exportResult.annotationsExported, 2);
  const reopened = await SpreadsheetDocumentAdapter.fromBuffer('customers.annotated.xlsx', exported);
  assert.equal(reopened.readRange('Customers', 'A1').rows[0]?.[0]?.value, 'Customer churn review');
  assert.equal(reopened.readRange('Customers', 'D3').rows[0]?.[0]?.value, 'Churn Risk');
  assert.deepEqual(reopened.readRange('Customers', 'D4:D5').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
  assert.equal(reopened.readRange('Notes', 'A1').rows[0]?.[0]?.value, 'Keep this sheet');
  assert.deepEqual(source, untouchedSource, 'the uploaded source bytes stay unchanged');

  const restored = await SpreadsheetDocumentAdapter.fromSavedState('customers.xlsx', exported, adapter.getChanges());
  assert.deepEqual(restored.getChanges(), adapter.getChanges(), 'review and approval records are restored with the working workbook');
  assert.equal(restored.readRange('Customers', 'A1').rows[0]?.[0]?.value, 'Customer churn review');
  assert.equal(restored.readRange('Customers', 'D3').rows[0]?.[0]?.value, 'Churn Risk');
  assert.deepEqual(restored.readRange('Customers', 'D4:D5').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
});

test('opens default-namespace drawing XML and preserves embedded images when exporting edits', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRows([['Metric', 'Value'], ['Revenue', 1200]]);
  const imageId = workbook.addImage({
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cZl8AAAAASUVORK5CYII=', 'base64') as never,
    extension: 'png',
  });
  sheet.addImage(imageId, 'D2:E5');
  const generated = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = await JSZip.loadAsync(generated);
  const drawingParts = Object.keys(zip.files).filter((name) => name.startsWith('xl/drawings/') && name.endsWith('.xml') && !name.includes('/_rels/'));
  assert.equal(drawingParts.length, 1);
  for (const name of drawingParts) {
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replaceAll('<xdr:', '<').replaceAll('</xdr:', '</').replaceAll('xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"', 'xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'));
  }
  const source = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  const originalSource = Buffer.from(source);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('image-report.xlsx', source);
  assert.equal(adapter.workbook.worksheets[0]?.getImages().length, 1);

  adapter.writeCell('Report', 'C2', 'Checked', 'Human-reviewed result.', undefined, false, 'image-sheet-cell');
  const exported = await adapter.export({ format: 'native-annotated' });
  const reopened = await SpreadsheetDocumentAdapter.fromBuffer('image-report-annotated.xlsx', exported.buffer);
  assert.deepEqual(reopened.readRange('Report', 'C2').rows[0]?.[0]?.value, 'Checked');
  assert.equal(reopened.workbook.worksheets[0]?.getImages().length, 1);
  assert.deepEqual(source, originalSource, 'normalization and editing leave uploaded source bytes unchanged');
});
