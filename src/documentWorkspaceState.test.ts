import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedWorkspaceBlock, markIntentPageIncomplete, reconcileIntentPage, scopeIntentResult } from './documentWorkspaceState';
import type { PaperBlock, PaperPageResult } from './paperOcrTypes';

const block = (id: string, extra: Partial<PaperBlock> = {}): PaperBlock => ({ id, type: 'region', bbox: { x: .1, y: .2, width: .3, height: .1 }, extractedText: 'Original text', latex: null, uncertain: false, uncertaintyReason: '', ...extra });
const page = (blocks: PaperBlock[]): PaperPageResult => ({ pageNumber: 1, sourcePageNumber: 9, blocks, warnings: [], model: 'gpt-6-astra', provider: 'codex-app-server', generatedAt: '2026-09-14T00:00:00Z' });

test('successful final output replaces provisional/old AI findings and preserves manual edits', () => {
  const manual = block('manual-1', { source: 'manual', label: 'My custom label', note: 'My private note.' });
  const edited = block('ai-2', { editedByHuman: true, label: 'Human correction' });
  const previous = page([manual, edited, block('old-ai'), block('run:proposal', { provisional: true })]);
  const resolved = reconcileIntentPage(previous, page([block('final-ai'), block('ai-2', { label: 'Model replacement' })]));
  assert.deepEqual(resolved.blocks.map((item) => item.id), ['manual-1', 'ai-2', 'final-ai']);
  assert.deepEqual(resolved.blocks[0], manual);
  assert.deepEqual(resolved.blocks[1], edited);
  assert.equal(resolved.status, 'complete');
  assert.equal(resolved.blocks.at(-1)?.provisional, false);
});

test('failed streamed proposals stay incomplete and cannot enter confirmed exports', () => {
  const existing = block('confirmed-before-run', { source: 'manual' });
  const partial = markIntentPageIncomplete(page([existing, block('run:partial', { provisional: true })]), 'The model disconnected.');
  assert.equal(partial.status, 'incomplete');
  assert.deepEqual(partial.blocks[0], existing, 'a failed AI run does not invalidate prior human work');
  assert.equal(partial.blocks[1]?.uncertain, true);
  assert.equal(partial.blocks[1]?.uncertaintyReason, 'The model disconnected.');
  assert.deepEqual(partial.blocks.filter(confirmedWorkspaceBlock).map((item) => item.id), ['confirmed-before-run']);
});

test('later runs retain a human-edited first result and a different newly-generated first result', () => {
  const first = scopeIntentResult(page([block('intent-p1-b1', { label: 'Original finding' })]), 'run-1');
  first.blocks[0] = { ...first.blocks[0]!, editedByHuman: true, label: 'My corrected label' };
  const next = scopeIntentResult(page([block('intent-p1-b1', { label: 'A different new finding', bbox: { x: .5, y: .6, width: .3, height: .1 } })]), 'run-2');
  const reconciled = reconcileIntentPage(first, next);
  assert.deepEqual(reconciled.blocks.map(({ id, label }) => ({ id, label })), [
    { id: 'run-1:intent-p1-b1', label: 'My corrected label' },
    { id: 'run-2:intent-p1-b1', label: 'A different new finding' },
  ]);
});
