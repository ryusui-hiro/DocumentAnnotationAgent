import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspaceState, writeWorkspaceState, type WorkspaceStateStorage } from './workspaceState';

function memoryStorage(): WorkspaceStateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

test('keeps saved annotations isolated by exact source-document hash', () => {
  const storage = memoryStorage();
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  writeWorkspaceState(storage, 'contract.pdf', first, { version: 4, sourceHash: first, documentAnnotations: [{ id: 'old' }] });
  writeWorkspaceState(storage, 'contract.pdf', second, { version: 4, sourceHash: second, documentAnnotations: [{ id: 'new' }] });

  assert.deepEqual(JSON.parse(readWorkspaceState(storage, 'contract.pdf', first).raw!).documentAnnotations, [{ id: 'old' }]);
  assert.deepEqual(JSON.parse(readWorkspaceState(storage, 'contract.pdf', second).raw!).documentAnnotations, [{ id: 'new' }]);
  assert.equal(readWorkspaceState(storage, 'contract.pdf', 'c'.repeat(64)).status, 'changed');
});

test('marks legacy workspaces without a document hash as unverified', () => {
  const storage = memoryStorage();
  writeWorkspaceState(storage, 'contract.pdf', undefined, { version: 3, documentId: 'old-session', documentAnnotations: [] });
  assert.equal(readWorkspaceState(storage, 'contract.pdf', 'a'.repeat(64)).status, 'legacy');
  assert.equal(readWorkspaceState(storage, 'contract.pdf').status, 'match');
});

test('reports a changed latest source without returning annotations from that source', () => {
  const storage = memoryStorage();
  const previous = 'd'.repeat(64);
  const current = 'e'.repeat(64);
  writeWorkspaceState(storage, 'deck.pptx', previous, { version: 4, sourceHash: previous, documentAnnotations: [{ id: 'old-slide' }] });
  assert.deepEqual(readWorkspaceState(storage, 'deck.pptx', current), {
    status: 'changed', raw: null, previousSourceHash: previous,
  });
});
