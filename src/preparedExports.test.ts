import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePreparedDocumentExports, restorePreparedDocumentExports } from './preparedExports';

const valid = {
  id: '1780000000000_123e4567-e89b-12d3-a456-426614174000',
  documentId: 'session-1', sourceDocumentName: 'contracts/sample.pdf', fileName: 'sample-annotations.csv',
  format: 'annotations-csv' as const, annotationsExported: 3, skippedCount: 0, expiresAt: Date.now() + 60_000,
};

test('restores only well-formed unexpired export descriptors for the requested document', () => {
  const restored = restorePreparedDocumentExports([valid, { ...valid, id: 'bad-id' }, { ...valid, sourceDocumentName: 'other.pdf' }, { ...valid, expiresAt: Date.now() - 1 }], 'contracts/sample.pdf');
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.id, valid.id);
  assert.deepEqual(restorePreparedDocumentExports('{invalid-json'), []);
});

test('merges export descriptors by token and discards expired entries', () => {
  const current = [{ ...valid, expiresAt: Date.now() + 30_000 }];
  const replacement = { ...valid, fileName: 'sample-annotated.pdf' };
  const added = { ...valid, id: '1780000000001_123e4567-e89b-12d3-a456-426614174001' };
  const merged = mergePreparedDocumentExports(current, [replacement, added, { ...valid, id: 'expired', expiresAt: Date.now() - 1 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((artifact) => artifact.id === valid.id)?.fileName, 'sample-annotated.pdf');
});
