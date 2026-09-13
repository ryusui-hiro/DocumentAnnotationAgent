import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDocumentAnnotationRecords, readStoredDocumentAnnotationRecords, restoreDocumentAnnotationRecords } from './documentAnnotations';

test('normalizes visual and spreadsheet annotations into a shared target and review schema', () => {
  const records = normalizeDocumentAnnotationRecords({
    documentId: 'doc-1',
    fileType: 'XLSX',
    annotations: [{
      id: 'page-annotation', pageNumber: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.1,
      label: 'HIGH RISK', note: 'Unilateral termination.', reason: 'Only one party can terminate.',
      excerpt: 'Either party may terminate', confidence: 0.91, color: '#178b87', source: 'ai',
    }],
    candidates: [{
      id: 'review-candidate', pageNumber: 3, x: 0.2, y: 0.4, width: 0.2, height: 0.1,
      label: 'MEDIUM RISK', note: 'Review this exception.', reason: 'The trigger is unclear.',
      excerpt: 'reasonable circumstances', confidence: 0.62, reviewPriority: 'high', requiresReview: true, color: '#e8a532', source: 'ai',
    }],
    rejectedCandidates: [],
    spreadsheetChanges: [{
      id: 'sheet-cell', operation: 'write_cell', sheetName: 'Customers', range: 'F2',
      values: [['HIGH']], reason: 'High ticket volume and no recent login.', confidence: 0.94,
      requiresReview: false, approved: true,
    }],
  });

  assert.deepEqual(records.map((record) => record.status), ['auto', 'needs_review', 'approved']);
  assert.deepEqual(records[0]?.target, { kind: 'page', page: 2, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } });
  assert.equal(records[1]?.reviewPriority, 'high');
  assert.equal(records[0]?.reviewPriority, 'medium');
  assert.equal(records[2]?.reviewPriority, 'medium');
  assert.deepEqual(records[2]?.target, { kind: 'sheet', sheet: 'Customers', cellRange: 'F2' });
  assert.equal(records.every((record) => record.documentId === 'doc-1'), true);
});

test('review priority does not change with the optional numeric model estimate', () => {
  const records = normalizeDocumentAnnotationRecords({
    documentId: 'priority-test', fileType: 'PDF',
    annotations: [0.01, 0.99].map((confidence, index) => ({
      id: `annotation-${index}`, pageNumber: index + 1, x: 0.1, y: 0.1, width: 0.4, height: 0.1,
      label: 'Finding', note: 'Evidence-backed result.', reason: 'Visible evidence supports this.',
      confidence, reviewPriority: 'low' as const, color: '#178b87', source: 'ai' as const,
    })),
    candidates: [], rejectedCandidates: [], spreadsheetChanges: [],
  });
  assert.deepEqual(records.map((record) => record.reviewPriority), ['low', 'low']);
});

test('canonical annotation IDs are unique and the latest review state wins', () => {
  const records = normalizeDocumentAnnotationRecords({
    documentId: 'dedupe-test', fileType: 'PDF',
    annotations: [{ id: 'same-id', pageNumber: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.1, label: 'Old', note: 'Existing', color: '#178b87', source: 'ai' }],
    candidates: [{ id: 'same-id', pageNumber: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.1, label: 'Updated', note: 'Needs review', requiresReview: true, color: '#e8a532', source: 'ai' }],
    rejectedCandidates: [], spreadsheetChanges: [],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.label, 'Updated');
  assert.equal(records[0]?.status, 'needs_review');
});

test('canonical records restore visual review states and spreadsheet changes without legacy arrays', () => {
  const records = normalizeDocumentAnnotationRecords({
    documentId: 'doc-old', fileType: 'PPTX',
    annotations: [{
      id: 'slide-approved', pageNumber: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.15,
      label: 'Traction', note: 'Quarterly growth chart.', reason: 'The slide shows measured growth.',
      excerpt: 'Revenue increased by 18%.', reviewPriority: 'low', color: '#178b87', source: 'ai',
    }],
    candidates: [{
      id: 'page-review', pageNumber: 4, x: 0.2, y: 0.3, width: 0.4, height: 0.1,
      label: 'Unsupported claim', note: 'Needs source.', reason: 'No citation is visible.', excerpt: 'Market leadership',
      reviewPriority: 'high', requiresReview: true, color: '#e8a532', source: 'ai',
    }],
    rejectedCandidates: [{
      id: 'page-rejected', pageNumber: 5, x: 0.2, y: 0.3, width: 0.4, height: 0.1,
      label: 'Duplicate', note: 'Already covered.', reason: 'A prior annotation covers this point.', excerpt: 'Growth',
      reviewPriority: 'medium', requiresReview: true, color: '#e8a532', source: 'ai',
    }],
    spreadsheetChanges: [{
      id: 'cell-change', operation: 'write_cell', sheetName: 'Customers', range: 'F2', values: [['HIGH']],
      reason: 'The account has repeated support escalations.', reviewPriority: 'high', requiresReview: false, approved: true,
    }],
  });
  const restored = restoreDocumentAnnotationRecords(records);
  assert.equal(restored.annotations[0]?.pageNumber, 3);
  assert.equal(restored.annotations[0]?.reviewPriority, 'low');
  assert.equal(restored.annotations[0]?.reason, 'The slide shows measured growth.');
  assert.equal(restored.candidates[0]?.id, 'page-review');
  assert.equal(restored.rejectedCandidates[0]?.id, 'page-rejected');
  assert.deepEqual(restored.spreadsheetChanges[0], {
    id: 'cell-change', operation: 'write_cell', sheetName: 'Customers', range: 'F2',
    values: [['HIGH']], reason: 'The account has repeated support escalations.',
    reviewPriority: 'high', requiresReview: false, approved: true,
  });
});

test('maps presentation page regions to slide targets and rejected items to rejected status', () => {
  const [record] = normalizeDocumentAnnotationRecords({
    documentId: 'slides-1', fileType: 'PPTX',
    annotations: [], candidates: [],
    rejectedCandidates: [{
      id: 'slide-rejected', pageNumber: 7, x: 0.1, y: 0.1, width: 0.5, height: 0.2,
      label: 'Unsupported claim', note: 'Rejected claim.', reason: 'No source.',
      excerpt: '90% of companies need this', confidence: 0.4, requiresReview: true, color: '#d36c74', source: 'ai',
    }],
    spreadsheetChanges: [],
  });
  assert.equal(record?.target.kind, 'slide');
  assert.equal(record?.status, 'rejected');
});

test('rebinds saved workspace annotations to a live session and tolerates malformed local state', () => {
  const saved = normalizeDocumentAnnotationRecords({
    documentId: 'expired-session', fileType: 'XLSX', annotations: [], candidates: [], rejectedCandidates: [],
    spreadsheetChanges: [{ id: 'saved-cell', operation: 'write_cell', sheetName: 'Customers', range: 'F2', values: [['HIGH']], reason: 'Evidence in the row supports the classification.', requiresReview: false, approved: true }],
  });
  const rebound = readStoredDocumentAnnotationRecords(JSON.stringify({ version: 3, documentAnnotations: saved }), 'new-session', 'XLSX');
  assert.equal(rebound[0]?.documentId, 'new-session');
  assert.equal(rebound[0]?.target.kind, 'sheet');
  assert.equal(rebound[0]?.status, 'approved');
  assert.deepEqual(readStoredDocumentAnnotationRecords('{broken-json', 'new-session', 'PDF'), []);
});
