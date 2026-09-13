import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SpreadsheetDocumentAdapter } from './spreadsheetAdapter';

async function createSourceWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const customers = workbook.addWorksheet('Customers');
  customers.addRows([
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

test('stages cell and column edits, applies only approved changes, and exports a separate workbook', async () => {
  const source = await createSourceWorkbook();
  const untouchedSource = Buffer.from(source);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);

  const riskColumn = adapter.createColumn('Customers', 'Churn Risk', 1, 'Classify each customer.', { requiresReview: true, id: 'proposal-column' });
  assert.equal(riskColumn.range, 'D1');
  assert.equal(adapter.readRange('Customers', 'D1').rows[0]?.[0]?.value, null);
  adapter.approveChange(riskColumn.id);
  assert.equal(adapter.readRange('Customers', 'D1').rows[0]?.[0]?.value, 'Churn Risk');

  const rejected = adapter.writeCell('Customers', 'D2', 'LOW', 'Aki has no support tickets.', 0.96, true, 'rejected-cell');
  adapter.rejectChange(rejected.id);
  assert.equal(adapter.readRange('Customers', 'D2').rows[0]?.[0]?.value, null);

  const accepted = adapter.writeRange('Customers', 'D2', [['LOW'], ['HIGH']], 'Risk classification based on activity.', 0.91, true, 'approved-range');
  adapter.approveChange(accepted.id);
  assert.deepEqual(adapter.readRange('Customers', 'D2:D3').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
  assert.equal(adapter.getChanges().find((change) => change.id === 'approved-range')?.approved, true);
  assert.equal(adapter.getChanges().find((change) => change.id === 'rejected-cell')?.rejected, true);

  const exportResult = await adapter.export({ format: 'native-annotated' });
  const exported = exportResult.buffer;
  assert.equal(exportResult.fileName, 'customers-annotated.xlsx');
  assert.equal(exportResult.annotationsExported, 2);
  const reopened = await SpreadsheetDocumentAdapter.fromBuffer('customers.annotated.xlsx', exported);
  assert.equal(reopened.readRange('Customers', 'D1').rows[0]?.[0]?.value, 'Churn Risk');
  assert.deepEqual(reopened.readRange('Customers', 'D2:D3').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
  assert.equal(reopened.readRange('Notes', 'A1').rows[0]?.[0]?.value, 'Keep this sheet');
  assert.deepEqual(source, untouchedSource, 'the uploaded source bytes stay unchanged');

  const restored = await SpreadsheetDocumentAdapter.fromSavedState('customers.xlsx', exported, adapter.getChanges());
  assert.deepEqual(restored.getChanges(), adapter.getChanges(), 'review and approval records are restored with the working workbook');
  assert.equal(restored.readRange('Customers', 'D1').rows[0]?.[0]?.value, 'Churn Risk');
  assert.deepEqual(restored.readRange('Customers', 'D2:D3').rows.map((row) => row[0]?.value), ['LOW', 'HIGH']);
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
