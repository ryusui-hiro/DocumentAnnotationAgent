import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { createAnnotationTaskPlan } from './taskPlanner';

const plan = {
  title: 'PII review',
  objective: 'Find and label personal data.',
  labels: [{ name: 'EMAIL', description: 'Email addresses' }],
  actions: ['Highlight each match', 'Attach an evidence excerpt'],
  uncertaintyPolicy: 'Ask a human when text is unreadable.',
  workflow: ['Read each page.', 'Mark matches.', 'Queue uncertain cases.'],
};

test('requests a strict task plan schema and validates the returned plan', async () => {
  const capture: { request?: Record<string, unknown> } = {};
  const client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        capture.request = request;
        return { output_text: JSON.stringify(plan), usage: { input_tokens: 50, output_tokens: 40, total_tokens: 90 } };
      },
    },
  } as unknown as OpenAI;
  const result = await createAnnotationTaskPlan({
    client,
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instruction: 'Find email addresses.',
    guidelines: 'Label them EMAIL.',
    correction: '',
    mode: 'assist',
  });

  assert.deepEqual(result.plan, plan);
  const captured = capture.request;
  assert.ok(captured);
  assert.equal(captured.store, false);
  const text = captured.text as { format?: { type?: string; strict?: boolean; schema?: unknown } } | undefined;
  assert.equal(text?.format?.type, 'json_schema');
  assert.equal(text?.format?.strict, true);
  assert.ok(text?.format?.schema);
});

test('rejects a planner output that does not satisfy the task schema', async () => {
  const client = {
    responses: { create: async () => ({ output_text: JSON.stringify({ title: 'Missing fields' }) }) },
  } as unknown as OpenAI;
  await assert.rejects(() => createAnnotationTaskPlan({
    client,
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instruction: 'Find email addresses.',
    guidelines: '',
    correction: '',
    mode: 'assist',
  }), /invalid structured plan/);
});
