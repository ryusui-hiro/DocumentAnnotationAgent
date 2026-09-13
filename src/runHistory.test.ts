import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxSavedAgentRuns, readAgentRunHistory, upsertAgentRunHistory, writeAgentRunHistory } from './runHistory';
import { localTaskPlan } from './taskPlan';
import type { AgentRunHistory } from './types';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function run(id: string, startedAt: number, status: AgentRunHistory['status'] = 'complete'): AgentRunHistory {
  return {
    id, fileName: 'contract.pdf', startedAt, endedAt: startedAt + 100,
    instruction: 'Find clauses', mode: 'assist', status, totalPages: 3, completedPages: 3,
    events: [{ id: `event-${id}`, phase: 'Planning', detail: 'Started', status: 'complete', createdAt: startedAt }],
  };
}

test('persists recent runs per document and marks an unfinished run interrupted on restore', () => {
  const storage = new MemoryStorage();
  const active = run('still-running', 100, 'running');
  active.taskPlan = localTaskPlan('個人情報を見つける');
  const entries = [...Array.from({ length: maxSavedAgentRuns + 2 }, (_, index) => run(`run-${index}`, index)), active];
  const bounded = entries.reduce((history, entry) => upsertAgentRunHistory(history, entry), [] as AgentRunHistory[]);
  writeAgentRunHistory(storage, 'contract.pdf', bounded);

  const restored = readAgentRunHistory(storage, 'contract.pdf');
  assert.equal(restored.length, maxSavedAgentRuns);
  assert.equal(restored[0]?.id, 'still-running');
  assert.equal(restored[0]?.status, 'interrupted');
  assert.match(restored[0]?.summary ?? '', /中断されました/);
  assert.ok(restored[0]?.endedAt);
  assert.equal(restored[0]?.taskPlan?.labels.some((label) => label.name === 'EMAIL'), true);
  assert.deepEqual(readAgentRunHistory(storage, 'other.pdf'), []);
});

test('persists bounded Observe findings separately from document annotations', () => {
  const storage = new MemoryStorage();
  const entry = run('observe-run', 200);
  entry.mode = 'observe';
  entry.observationFindings = [{
    id: 'observed-warning', pageNumber: 1, x: 0.1, y: 0.2, width: 0.4, height: 0.1,
    label: 'SAFETY WARNING', note: 'Disconnect the power before servicing.', color: '#278779', source: 'ai',
    reviewPriority: 'high', requiresReview: true, reason: 'The warning contains a safety instruction.', excerpt: 'Disconnect the power before servicing.',
    fragments: [{ x: 0.1, y: 0.2, width: 0.24, height: 0.03 }, { x: 0.1, y: 0.24, width: 0.3, height: 0.03 }],
    textAnchor: { quote: { exact: 'Disconnect the power before servicing.', prefix: '', suffix: 'fan.' }, position: { start: 0, end: 38, unit: 'normalized-page-text' } },
  }];
  entry.observationFindingOverflow = 3;
  const updated = upsertAgentRunHistory([], entry);
  writeAgentRunHistory(storage, 'contract.pdf', updated);

  const restored = readAgentRunHistory(storage, 'contract.pdf')[0];
  assert.equal(restored?.observationFindings?.length, 1);
  assert.equal(restored?.observationFindings?.[0]?.label, 'SAFETY WARNING');
  assert.equal(restored?.observationFindings?.[0]?.requiresReview, true);
  assert.equal(restored?.observationFindings?.[0]?.fragments?.length, 2);
  assert.equal(restored?.observationFindings?.[0]?.textAnchor?.quote.exact, 'Disconnect the power before servicing.');
  assert.equal(restored?.observationFindingOverflow, 3);
  assert.equal('annotations' in (restored ?? {}), false, 'read-only findings remain outside the annotation state');
});

test('keeps run history separate when the same file name has different source content', () => {
  const storage = new MemoryStorage();
  const originalHash = 'a'.repeat(64);
  const changedHash = 'b'.repeat(64);
  const original = run('original-version', 300);
  original.sourceHash = originalHash;
  const changed = run('changed-version', 400);
  changed.sourceHash = changedHash;

  writeAgentRunHistory(storage, 'contract.pdf', [original], originalHash);
  writeAgentRunHistory(storage, 'contract.pdf', [changed], changedHash);

  assert.deepEqual(readAgentRunHistory(storage, 'contract.pdf', originalHash).map((run) => run.id), ['original-version']);
  assert.deepEqual(readAgentRunHistory(storage, 'contract.pdf', changedHash).map((run) => run.id), ['changed-version']);
  assert.deepEqual(readAgentRunHistory(storage, 'contract.pdf'), []);
});

test('persists per-page coverage without treating unread or unprocessed pages as empty', () => {
  const storage = new MemoryStorage();
  const entry = run('coverage-run', 500);
  entry.sourceHash = 'c'.repeat(64);
  entry.totalPages = 4;
  entry.completedPages = 1;
  entry.pageCoverageTargets = [1, 2, 3, 4];
  entry.pageCoverage = [
    { pageNumber: 1, status: 'checked', findingCount: 0, reviewCount: 0, warningCount: 0, textBlockCount: 12 },
    { pageNumber: 2, status: 'image_only', findingCount: 0, reviewCount: 1, warningCount: 1, textBlockCount: 0, detail: 'No selectable text was available.' },
    { pageNumber: 3, status: 'failed', findingCount: 0, reviewCount: 0, warningCount: 2, detail: 'Page conversion failed.' },
  ];
  writeAgentRunHistory(storage, entry.fileName, [entry], entry.sourceHash);

  const restored = readAgentRunHistory(storage, entry.fileName, entry.sourceHash)[0];
  assert.equal(restored?.pageCoverage?.length, 3);
  assert.equal(restored?.pageCoverage?.find((page) => page.pageNumber === 1)?.status, 'checked');
  assert.equal(restored?.pageCoverage?.find((page) => page.pageNumber === 2)?.status, 'image_only');
  assert.equal(restored?.pageCoverage?.find((page) => page.pageNumber === 3)?.status, 'failed');
  assert.equal(restored?.pageCoverage?.some((page) => page.pageNumber === 4), false, 'unprocessed pages stay absent instead of looking like no-findings pages');
  assert.deepEqual(restored?.pageCoverageTargets, [1, 2, 3, 4]);
});
