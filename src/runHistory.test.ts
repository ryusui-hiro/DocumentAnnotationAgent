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
  }];
  entry.observationFindingOverflow = 3;
  const updated = upsertAgentRunHistory([], entry);
  writeAgentRunHistory(storage, 'contract.pdf', updated);

  const restored = readAgentRunHistory(storage, 'contract.pdf')[0];
  assert.equal(restored?.observationFindings?.length, 1);
  assert.equal(restored?.observationFindings?.[0]?.label, 'SAFETY WARNING');
  assert.equal(restored?.observationFindings?.[0]?.requiresReview, true);
  assert.equal(restored?.observationFindingOverflow, 3);
  assert.equal('annotations' in (restored ?? {}), false, 'read-only findings remain outside the annotation state');
});
