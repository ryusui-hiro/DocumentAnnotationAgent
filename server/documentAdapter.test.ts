import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import type { PreviewReport } from 'document-svg';
import { PagedDocumentAdapter, searchDocumentAdapters, type DocumentAdapter } from './documentAdapter';

async function decodedPageContentStreams(pdf: PDFDocument, pageIndex: number) {
  const page = pdf.getPage(pageIndex);
  const contents = page.node.Contents();
  const entries = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return entries.map((entry) => {
    const stream = pdf.context.lookup(entry);
    assert.ok(stream instanceof PDFRawStream, 'page content entry resolves to a PDF stream');
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  });
}

function readSimpleWinAnsiText(content: string) {
  return [...content.matchAll(/<([0-9a-f]+)>\s*Tj/giu)]
    .map((match) => Buffer.from(match[1]!, 'hex').toString('latin1'))
    .join('');
}

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

test('PDF structure exposes cautious heading candidates and aligned table row evidence', () => {
  const report = {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{
      number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><text x="8" y="26" font-size="20" font-weight="700">Contract Review</text><text x="10" y="65" font-size="10" font-weight="700">Party</text><text x="70" y="65" font-size="10" font-weight="700">Right</text><text x="10" y="85" font-size="10">Buyer</text><text x="70" y="85" font-size="10">May terminate on notice</text><text x="8" y="110" font-size="20" font-weight="700">55 dBA maximum</text><text x="8" y="132" font-size="20" font-weight="700">WARNING Isolate the power supply.</text></svg>',
    }],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('contract.pdf', report);

  const outlinePage = adapter.getStructure().pages?.[0];
  assert.equal(outlinePage?.headingCandidates?.length, 1);
  assert.deepEqual(outlinePage?.headingCandidates?.[0]?.text, 'Contract Review');
  assert.equal(outlinePage?.headingCandidates?.[0]?.fontSize, 20);
  assert.equal(outlinePage?.headingCandidates?.[0]?.bold, true);
  assert.ok(outlinePage?.headingCandidates?.[0]?.boundingBox.x! > 0.06);

  const rowHints = adapter.getPageTextRowHints(1);
  assert.deepEqual(rowHints.map((row) => row.cells.map((cell) => cell.text)), [
    ['Party', 'Right'],
    ['Buyer', 'May terminate on notice'],
  ]);
  assert.ok(rowHints[0]!.cells[0]!.boundingBox.x < rowHints[0]!.cells[1]!.boundingBox.x);
  assert.equal(rowHints[0]!.cells[0]!.bold, true);
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

test('PDF native export preserves searchable source content and adds vector annotations without changing the source', async () => {
  const sourcePdf = await PDFDocument.create();
  const sourcePage = sourcePdf.addPage([612, 792]);
  const sourceFont = await sourcePdf.embedFont(StandardFonts.Helvetica);
  sourcePage.drawText('Clause remains text-searchable in the exported PDF.', { x: 48, y: 700, size: 14, font: sourceFont });
  const sourceBuffer = Buffer.from(await sourcePdf.save());
  const originalBytes = Buffer.from(sourceBuffer);
  const originalHash = createHash('sha256').update(sourceBuffer).digest('hex');
  const sourceContentStreams = await decodedPageContentStreams(await PDFDocument.load(sourceBuffer), 0);
  const report = {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{
      number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><text x="48" y="92">Clause remains text-searchable in the exported PDF.</text></svg>',
    }],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('searchable.pdf', report, 'searchable-pdf', sourceBuffer);
  adapter.replaceAnnotations([{
    id: 'source-pdf-annotation', documentId: 'searchable-pdf',
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 } },
    label: 'TERMINATION', evidence: 'Clause remains text-searchable.', explanation: 'This clause is in scope.',
    reviewPriority: 'low', status: 'auto', color: '#278779',
  }]);

  const result = await adapter.export({ format: 'native-annotated' });
  const exportedPdf = await PDFDocument.load(result.buffer);
  const exportedContentStreams = await decodedPageContentStreams(exportedPdf, 0);
  const extractedText = readSimpleWinAnsiText(exportedContentStreams.join('\n'));

  assert.equal(result.fileName, 'searchable-annotated.pdf');
  assert.equal(result.annotationsExported, 1);
  assert.equal(exportedPdf.getPageCount(), 1, 'export keeps the original page structure');
  assert.match(extractedText, /Clause remains text-searchable in the exported PDF\./);
  assert.ok(sourceContentStreams.some((stream) => exportedContentStreams.includes(stream)), 'the original page content stream remains in the output');
  const overlayStreams = exportedContentStreams.filter((stream) => !sourceContentStreams.includes(stream)).join('\n');
  assert.match(overlayStreams, /244\.8/, 'the annotation rectangle width was added as PDF vector content');
  assert.match(overlayStreams, /79\.2/, 'the annotation rectangle height was added as PDF vector content');
  assert.deepEqual(sourceBuffer, originalBytes, 'export does not mutate the supplied source bytes');
  assert.equal(createHash('sha256').update(sourceBuffer).digest('hex'), originalHash, 'the original source hash is unchanged');
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
