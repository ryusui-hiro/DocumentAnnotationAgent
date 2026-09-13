import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreviewReport } from 'document-svg';
import { PagedDocumentAdapter, searchDocumentAdapters, type DocumentAdapter } from './documentAdapter';

test('paged adapter exposes structure, inspects page SVG, and searches text across pages', () => {
  const report = {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg><text x="40" y="80">Termination for convenience</text></svg>' },
      { number: 2, widthPoints: 612, heightPoints: 792, warningCount: 1, warnings: ['low resolution'], svg: '<svg><text x="24" y="50">Termination &#x2014; review</text></svg>' },
    ],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('contract.pdf', report);

  assert.equal(adapter.open().fileName, 'contract.pdf');
  assert.equal(adapter.getStructure().kind, 'paged');
  assert.equal(adapter.getStructure().pages?.length, 2);
  assert.equal(adapter.inspect({ kind: 'page', pageNumber: 2 }).kind, 'page');
  assert.deepEqual(adapter.search('termination').map((item) => item.location), [
    { kind: 'page', pageNumber: 1 },
    { kind: 'page', pageNumber: 2 },
  ]);
  assert.match(adapter.search('termination')[1]?.excerpt ?? '', /Termination — review/);
});

test('paged adapter keeps canonical review records and exports approved annotations through one format adapter', async () => {
  const report = {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Clause</text></svg>' }],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('contract.pdf', report, 'doc-1');
  const record = {
    id: 'confirmed-1', documentId: 'doc-1', target: { kind: 'page' as const, page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 } },
    label: 'TERMINATION', evidence: 'Either party may terminate.', explanation: 'The clause allows termination.', reviewPriority: 'medium' as const, status: 'auto' as const,
  };
  const review = { ...record, id: 'review-1', status: 'needs_review' as const, reviewPriority: 'high' as const };
  adapter.replaceAnnotations([record, review]);
  assert.deepEqual(adapter.listAnnotations().map((annotation) => annotation.status), ['auto', 'needs_review']);
  assert.throws(() => adapter.annotate({ ...record, documentId: 'another-document' }), /different document/);
  assert.throws(() => adapter.annotate({ ...record, target: { ...record.target, boundingBox: { x: 0.9, y: 0.2, width: 0.4, height: 0.1 } } }), /fit inside/);
  assert.throws(() => adapter.replaceAnnotations([record, { ...review, target: { ...review.target, page: 99 } }]), /target does not exist/);
  assert.deepEqual(adapter.listAnnotations().map((annotation) => annotation.id), ['confirmed-1', 'review-1'], 'a rejected replacement leaves the prior adapter state intact');

  const json = await adapter.export({ format: 'annotations-json' });
  const jsonBody = JSON.parse(json.buffer.toString()) as { documentAnnotations: Array<{ id: string }> };
  assert.deepEqual(jsonBody.documentAnnotations.map((annotation) => annotation.id), ['confirmed-1', 'review-1']);

  const csv = await adapter.export({ format: 'annotations-csv' });
  const csvBody = csv.buffer.toString('utf8');
  assert.equal(csv.fileName, 'contract-annotations.csv');
  assert.ok(csvBody.startsWith('\uFEFF'));
  assert.match(csvBody, /"review-1"/);
  assert.match(csvBody, /"needs_review"/);

  const native = await adapter.export({ format: 'native-annotated' });
  assert.match(native.buffer.toString('latin1', 0, 8), /^%PDF-/);
  assert.equal(native.annotationsExported, 1, 'review-only records remain in JSON but are not applied to native exports');
});

test('search combines matches from paged and spreadsheet adapters without changing target types', () => {
  const pages = new PagedDocumentAdapter('contract.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg><text>Churn risk appears in this appendix.</text></svg>' }],
  } as unknown as PreviewReport);
  const spreadsheet: DocumentAdapter = {
    open: () => ({ fileName: 'customers.xlsx', fileType: 'XLSX', kind: 'spreadsheet' }),
    getStructure: () => ({ fileName: 'customers.xlsx', fileType: 'XLSX', kind: 'spreadsheet' }),
    inspect: () => { throw new Error('not used in search test'); },
    search: (query: string) => query === 'churn' ? [{ location: { kind: 'sheet', sheetName: 'Customers', range: 'E2' }, excerpt: 'HIGH', matchType: 'cell' as const }] : [],
    annotate: (annotation) => annotation,
    replaceAnnotations: () => undefined,
    listAnnotations: () => [],
    removeAnnotation: () => false,
    export: async (request) => ({ format: request.format, fileName: 'customers.json', contentType: 'application/json', buffer: Buffer.from('{}'), annotationsExported: 0, skipped: [] }),
  };
  const matches = searchDocumentAdapters([pages, spreadsheet], 'churn');

  assert.deepEqual(matches.map((item) => item.location), [
    { kind: 'page', pageNumber: 1 },
    { kind: 'sheet', sheetName: 'Customers', range: 'E2' },
  ]);
});
