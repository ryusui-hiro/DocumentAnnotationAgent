import assert from 'node:assert/strict';
import test from 'node:test';
import { createHumanDecisionRecord, readHumanDecisionRecords, recordHumanDecision } from './humanDecisionScope';

test('item-only corrections stay out of guidance for remaining pages', () => {
  const decision = createHumanDecisionRecord([], {
    id: 'decision-item', action: 'correct', scope: 'item', sourceCandidateId: 'candidate-1', pageNumber: 1,
    text: 'Corrected the date label', createdAt: 10,
  });
  const result = recordHumanDecision({ decisionContext: 'existing rule' }, decision.text, decision);
  assert.equal(result.decisionContext, 'existing rule');
  assert.match(result.pageDecisionContext, /THIS ITEM ONLY; DO NOT GENERALIZE/);
  assert.match(result.pageDecisionContext, /Corrected the date label/);
});

test('remaining-page rules are explicitly persisted as general guidance', () => {
  const decision = createHumanDecisionRecord([], {
    id: 'decision-rule-1', action: 'correct', scope: 'remaining_pages', sourceCandidateId: 'candidate-1', pageNumber: 1,
    text: 'Treat unsigned extensions as high risk', createdAt: 10, appliesFromPage: 2,
  });
  const result = recordHumanDecision({ decisionContext: 'earlier rule' }, decision.text, decision);
  assert.match(result.decisionContext, /earlier rule/);
  assert.match(result.decisionContext, /RULE FOR REMAINING PAGES/);
  assert.match(result.decisionContext, /v1; applies from P\.2/);
  assert.match(result.pageDecisionContext, /Treat unsigned extensions as high risk/);
});

test('multiple decisions on one blocked page are accumulated in order', () => {
  const firstDecision = createHumanDecisionRecord([], {
    id: 'decision-a', action: 'correct', scope: 'item', sourceCandidateId: 'candidate-a', pageNumber: 1,
    text: 'Keep the original label for clause A', createdAt: 10,
  });
  const secondDecision = createHumanDecisionRecord([firstDecision], {
    id: 'decision-b', action: 'correct', scope: 'item', sourceCandidateId: 'candidate-b', pageNumber: 1,
    text: 'Use high risk for clause B', createdAt: 11,
  });
  const first = recordHumanDecision({}, firstDecision.text, firstDecision);
  const second = recordHumanDecision(first, secondDecision.text, secondDecision);
  assert.ok(second.pageDecisionContext.indexOf('clause A') < second.pageDecisionContext.indexOf('clause B'));
  assert.equal(second.decisionContext, '');
});

test('remaining-page rule versions increase and stored scopes are validated', () => {
  const first = createHumanDecisionRecord([], {
    id: 'rule-1', action: 'correct', scope: 'remaining_pages', sourceCandidateId: 'candidate-1', pageNumber: 1,
    text: 'Use high risk for missing controls.', createdAt: 10, appliesFromPage: 2,
  });
  const second = createHumanDecisionRecord([first], {
    id: 'rule-2', action: 'correct', scope: 'remaining_pages', sourceCandidateId: 'candidate-2', pageNumber: 2,
    text: 'Exceptions with a named approver are medium risk.', createdAt: 20, appliesFromPage: 3,
  });
  assert.equal(first.ruleVersion, 1);
  assert.equal(second.ruleVersion, 2);
  assert.deepEqual(readHumanDecisionRecords([first, second, { ...second, id: 'bad', ruleVersion: 0 }]), [first, second]);
});

test('rule versions stay monotonic after older decision records are pruned', () => {
  const retainedItems = Array.from({ length: 100 }, (_, index) => ({
    id: `item-${index}`, action: 'approve' as const, scope: 'item' as const,
    sourceCandidateId: `candidate-${index}`, pageNumber: 1, text: `Decision ${index}`, createdAt: index,
  }));
  const next = createHumanDecisionRecord(retainedItems, {
    id: 'rule-after-pruning', action: 'correct', scope: 'remaining_pages', sourceCandidateId: 'candidate-rule', pageNumber: 2,
    text: 'Keep rule versions increasing.', createdAt: 101, appliesFromPage: 3,
  }, 7);
  assert.equal(next.ruleVersion, 8);
});
