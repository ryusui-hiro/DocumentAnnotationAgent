import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localTaskPlan, parseTaskPlan, taskPlanAsInstructions, taskPlanJsonSchema, taskPlanSignature } from './taskPlan';

test('turns a natural-language PII request into a bounded annotation plan', () => {
  const plan = localTaskPlan('個人情報をすべて見つけて分類してください。', '曖昧なら確認してください。');
  assert.equal(plan.labels.some((label) => label.name === 'EMAIL'), true);
  assert.match(plan.uncertaintyPolicy, /人の確認/);
  assert.deepEqual(parseTaskPlan(plan), plan);
  assert.match(taskPlanAsInstructions(plan), /Task: 個人情報/);
});

test('turns a safety-warning and torque extraction request into evidence-specific labels', () => {
  const plan = localTaskPlan(
    '安全上の警告と締結トルクを抽出',
    '該当箇所を囲み、簡潔なラベルと文書上の根拠を付けてください。判断が曖昧な場合は確認が必要としてください。',
  );
  assert.deepEqual(plan.labels.map((label) => label.name), ['SAFETY_WARNING', 'FASTENING_TORQUE']);
  assert.doesNotMatch(plan.labels.map((label) => label.name).join(' '), /CLAIM|EVIDENCE|ASSUMPTION|CITATION_NEEDED/);
  assert.match(plan.actions.join(' '), /数値・単位/);
  assert.match(plan.uncertaintyPolicy, /単位/);
  assert.match(taskPlanAsInstructions(plan), /FASTENING_TORQUE/);
  assert.match(taskPlanAsInstructions(plan), /preserve numeric units/);
});

test('task plan signature changes with the task or mode', () => {
  const base = taskPlanSignature('Find risks', 'High means severe', '', 'assist', 'gpt-6-astra', 'openai-api');
  assert.notEqual(base, taskPlanSignature('Find PII', 'High means severe', '', 'assist', 'gpt-6-astra', 'openai-api'));
  assert.notEqual(base, taskPlanSignature('Find risks', 'High means severe', '', 'suggest', 'gpt-6-astra', 'openai-api'));
});

test('structured plan schema matches parser string limits', () => {
  const properties = taskPlanJsonSchema.properties;
  assert.equal(properties.title.maxLength, 120);
  assert.equal(properties.objective.maxLength, 500);
  assert.equal(properties.uncertaintyPolicy.maxLength, 400);
  assert.equal(properties.labels.items.properties.name.maxLength, 60);
  assert.equal(properties.labels.items.properties.description.maxLength, 240);
  assert.equal(properties.actions.items.maxLength, 80);
  assert.equal(properties.workflow.items.maxLength, 120);

  const oversizedPlan = localTaskPlan('Find risks');
  oversizedPlan.title = 'x'.repeat(121);
  assert.equal(parseTaskPlan(oversizedPlan), null);
});
