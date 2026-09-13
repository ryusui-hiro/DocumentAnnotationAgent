import assert from 'node:assert/strict';
import test from 'node:test';
import { recordHumanDecision } from './humanDecisionScope';

test('item-only corrections stay out of guidance for remaining pages', () => {
  const result = recordHumanDecision({ decisionContext: 'existing rule' }, 'Corrected the date label', 'item');
  assert.equal(result.decisionContext, 'existing rule');
  assert.match(result.pageDecisionContext, /THIS ITEM ONLY; DO NOT GENERALIZE/);
  assert.match(result.pageDecisionContext, /Corrected the date label/);
});

test('remaining-page rules are explicitly persisted as general guidance', () => {
  const result = recordHumanDecision({ decisionContext: 'earlier rule' }, 'Treat unsigned extensions as high risk', 'remaining_pages');
  assert.match(result.decisionContext, /earlier rule/);
  assert.match(result.decisionContext, /RULE FOR REMAINING PAGES/);
  assert.match(result.pageDecisionContext, /Treat unsigned extensions as high risk/);
});

test('multiple decisions on one blocked page are accumulated in order', () => {
  const first = recordHumanDecision({}, 'Keep the original label for clause A', 'item');
  const second = recordHumanDecision(first, 'Use high risk for clause B', 'item');
  assert.ok(second.pageDecisionContext.indexOf('clause A') < second.pageDecisionContext.indexOf('clause B'));
  assert.equal(second.decisionContext, '');
});
