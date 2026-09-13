import assert from 'node:assert/strict';
import test from 'node:test';
import { findInconsistentRepeatedExcerpts, restoreAnnotationConsistencyIssues } from './consistency';

test('flags repeated source excerpts that received conflicting labels', () => {
  const issues = findInconsistentRepeatedExcerpts([
    { id: 'a', pageNumber: 3, label: 'HIGH', excerpt: 'Either party may terminate this agreement with thirty days notice.' },
    { id: 'b', pageNumber: 11, label: 'MEDIUM', excerpt: ' either  party may terminate this agreement with thirty days notice. ' },
  ]);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]?.labels, ['HIGH', 'MEDIUM']);
  assert.deepEqual(issues[0]?.occurrences.map((item) => item.pageNumber), [3, 11]);
});

test('ignores short excerpts, duplicate annotation ids, and repeated excerpts with the same label', () => {
  const issues = findInconsistentRepeatedExcerpts([
    { id: 'short-a', pageNumber: 1, label: 'HIGH', excerpt: 'short text' },
    { id: 'short-b', pageNumber: 2, label: 'LOW', excerpt: 'short text' },
    { id: 'same-a', pageNumber: 3, label: 'Risk', excerpt: 'The vendor may terminate this agreement with thirty days notice.' },
    { id: 'same-b', pageNumber: 4, label: 'risk', excerpt: 'The vendor may terminate this agreement with thirty days notice.' },
    { id: 'same-a', pageNumber: 5, label: 'LOW', excerpt: 'The vendor may terminate this agreement with thirty days notice.' },
  ]);
  assert.deepEqual(issues, []);
});

test('flags substantially similar excerpts with conflicting labels as a possible consistency issue', () => {
  const issues = findInconsistentRepeatedExcerpts([
    { id: 'vendor-clause', pageNumber: 3, label: 'HIGH', excerpt: 'The vendor may terminate this agreement with thirty days written notice.' },
    { id: 'party-clause', pageNumber: 18, label: 'MEDIUM', excerpt: 'Either party may terminate this agreement upon thirty days written notice.' },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, 'similar_excerpt');
  assert.deepEqual(issues[0]?.labels, ['HIGH', 'MEDIUM']);
  assert.deepEqual(issues[0]?.occurrences.map((item) => item.pageNumber), [3, 18]);
  assert.equal(issues[0]?.occurrences[0]?.excerpt.includes('vendor'), true);
  assert.equal(issues[0]?.occurrences[1]?.excerpt.includes('Either party'), true);
});

test('does not flag unrelated long excerpts or similar items on the same page', () => {
  const issues = findInconsistentRepeatedExcerpts([
    { id: 'term', pageNumber: 4, label: 'HIGH', excerpt: 'The vendor may terminate this agreement with thirty days written notice.' },
    { id: 'privacy', pageNumber: 5, label: 'LOW', excerpt: 'Customer account information will be encrypted using approved security standards.' },
    { id: 'same-page', pageNumber: 4, label: 'MEDIUM', excerpt: 'Either party may terminate this agreement upon thirty days written notice.' },
  ]);
  assert.deepEqual(issues, []);
});

test('restores bounded consistency findings from a saved document workspace', () => {
  const restored = restoreAnnotationConsistencyIssues([
    {
      id: 'validator:item', kind: 'model_review', validatorType: 'evidence_gap', validatorTitle: 'Check support',
      validatorReason: 'The source excerpt is incomplete.', reviewPriority: 'high', excerpt: 'A claim', labels: ['Claim'],
      occurrences: [{ annotationId: 'a', pageNumber: 2, label: 'Claim', excerpt: 'A claim' }],
    },
    { id: 'invalid', kind: 'unknown', occurrences: [] },
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.kind, 'model_review');
  assert.equal(restored[0]?.validatorReason, 'The source excerpt is incomplete.');
});
