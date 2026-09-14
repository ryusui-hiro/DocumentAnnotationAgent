import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedModel, assistantMessage, modelResponse } from '@openai/agents/testing';
import { runAnnotationValidator, sanitizeValidatorFindings, type ValidatorAnnotation } from './annotationValidator';

const annotations: ValidatorAnnotation[] = [
  { id: 'risk-high', pageNumber: 3, label: 'HIGH', excerpt: 'The vendor may terminate this agreement.', explanation: 'Unilateral termination right.', reviewPriority: 'medium', status: 'auto' },
  { id: 'risk-medium', pageNumber: 18, label: 'MEDIUM', excerpt: 'Either party may terminate this agreement under similar terms.', explanation: 'Termination right.', reviewPriority: 'medium', status: 'auto' },
  { id: 'risk-low', pageNumber: 28, label: 'LOW', excerpt: 'No termination right is granted here.', explanation: 'A negated statement.', reviewPriority: 'low', status: 'auto' },
];

test('runs an independent structured-output Validator Agent and resolves only known annotation IDs', async () => {
  const model = new ScriptedModel([modelResponse([assistantMessage(JSON.stringify({ findings: [
    { kind: 'label_conflict', annotationIds: ['risk-high', 'risk-medium', 'not-in-document'], title: 'Possible termination label conflict', reason: 'The excerpts describe similar termination language but use different risk labels.', reviewPriority: 'high' },
    { kind: 'unsupported_claim', annotationIds: ['risk-low'], title: 'Evidence is missing', reason: 'The excerpt is a negated statement and may not support the claim.', reviewPriority: 'medium' },
  ] }))])]);
  const result = await runAnnotationValidator({
    model: 'gpt-6-astra', reasoningEffort: 'medium',
    instruction: 'Classify termination clauses as risk.', taskPlan: 'High, medium, or low.', guidelines: 'Use the exact source wording.', annotations,
  }, model);
  model.assertComplete();
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[0]?.annotationIds, ['risk-high', 'risk-medium']);
  assert.deepEqual(result.findings[0]?.occurrences.map((item) => item.pageNumber), [3, 18]);
  assert.equal(result.findings[0]?.reviewPriority, 'high');
  assert.equal(result.findings[1]?.kind, 'unsupported_claim');
});

test('drops duplicate-ID conflict reports and filters hallucinated IDs', () => {
  const findings = sanitizeValidatorFindings({ findings: [
    { kind: 'label_conflict', annotationIds: ['risk-high', 'risk-high'], title: 'Not a conflict', reason: 'Only one annotation was referenced twice.', reviewPriority: 'low' },
    { kind: 'label_conflict', annotationIds: ['invented-a', 'invented-b'], title: 'Unknown records', reason: 'These IDs are not present.', reviewPriority: 'high' },
    { kind: 'evidence_gap', annotationIds: ['risk-low', 'unknown'], title: 'Check evidence', reason: 'The excerpt does not support the label.', reviewPriority: 'medium' },
  ] }, annotations);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'evidence_gap');
  assert.deepEqual(findings[0]?.annotationIds, ['risk-low']);
});
