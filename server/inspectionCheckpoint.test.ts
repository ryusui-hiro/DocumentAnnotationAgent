import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionScopeKey, mergeInspectionCheckpoint, sanitizeInspectionCheckpoints } from './inspectionCheckpoint';

const sourceHash = 'a'.repeat(64);
const scope = {
  documentId: 'doc-1', sourceHash, totalPages: 3,
  instruction: ' Review the termination clauses. ', taskPlan: 'Find risk.', guidelines: 'Use evidence.', mode: 'assist',
};

test('inspection scope keys are stable for segments and change when task/source scope changes', () => {
  const key = inspectionScopeKey(scope);
  assert.equal(key, inspectionScopeKey({ ...scope, instruction: scope.instruction.trim() }));
  assert.notEqual(key, inspectionScopeKey({ ...scope, sourceHash: 'b'.repeat(64) }));
  assert.notEqual(key, inspectionScopeKey({ ...scope, totalPages: 4 }));
  assert.notEqual(key, inspectionScopeKey({ ...scope, taskPlan: 'Different plan.' }));
  assert.notEqual(key, inspectionScopeKey({ ...scope, mode: 'observe' }));
});

test('inspection checkpoints merge only valid pages and sanitize persisted state', () => {
  const key = inspectionScopeKey(scope);
  const first = mergeInspectionCheckpoint(undefined, key, sourceHash, 3, [1, 2], 1_000);
  const second = mergeInspectionCheckpoint(first, key, sourceHash, 3, [2, 3, 99], 2_000);
  assert.deepEqual(second[key]?.pages, [1, 2, 3]);
  assert.deepEqual(sanitizeInspectionCheckpoints(second, sourceHash, 3, 2_001), second);
  assert.deepEqual(sanitizeInspectionCheckpoints(second, 'b'.repeat(64), 3, 2_001), {});
  assert.deepEqual(sanitizeInspectionCheckpoints(second, sourceHash, 4, 2_001), {});
});

test('expired, malformed, and excessive inspection checkpoints are discarded', () => {
  const key = inspectionScopeKey(scope);
  const valid = { sourceHash, totalPages: 3, pages: [1], updatedAt: 2_000_000 };
  const malformed = { sourceHash, totalPages: 3, pages: [1, 1], updatedAt: 2_000_000 };
  const stale = { sourceHash, totalPages: 3, pages: [1, 2], updatedAt: 1 };
  const tooMany = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
    index.toString(16).padStart(64, '0'), { ...valid, updatedAt: 2_000_000 + index },
  ]));
  const cleaned = sanitizeInspectionCheckpoints({ [key]: valid, ['f'.repeat(64)]: malformed, ['e'.repeat(64)]: stale }, sourceHash, 3, 2_000_100);
  assert.deepEqual(Object.keys(cleaned), [key]);
  assert.equal(Object.keys(sanitizeInspectionCheckpoints(tooMany, sourceHash, 3, 2_000_100)).length, 12);
});
