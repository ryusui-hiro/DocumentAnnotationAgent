import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntentAnnotationOutputSchema, IntentBlockStream, intentAnnotationOutputSchema, intentAnnotationPrompt, parseIntentAnnotationOutput, validateIntentLabelRules, type IntentAnnotationBlock } from './intentAnnotator';

const rules = [{ name: 'Accepted', description: 'A visible approval decision.' }, { name: 'Needs revision', description: 'A visible request to change the document.' }];
const block = { type: 'region', label: 'Accepted', note: 'Visible acceptance.', bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, extractedText: 'Approved', latex: null, uncertain: false, uncertaintyReason: '' };
const schemaLabel = (value: unknown) => JSON.parse(JSON.stringify(value)).properties.blocks.items.properties.label;

test('provided label rules create an exact per-request enum without changing dynamic-label defaults', () => {
  const configured = createIntentAnnotationOutputSchema(rules);
  assert.deepEqual(schemaLabel(configured).enum, ['Accepted', 'Needs revision']);
  assert.equal(schemaLabel(createIntentAnnotationOutputSchema([])).enum, undefined);
  assert.equal(schemaLabel(intentAnnotationOutputSchema).enum, undefined);
  const dynamic = parseIntentAnnotationOutput(JSON.stringify({ blocks: [{ ...block, label: 'New intent-derived label' }], warnings: [] }), 1);
  assert.equal(dynamic.blocks[0]?.label, 'New intent-derived label');
});

test('label definitions are included in the prompt and labels are never silently remapped', () => {
  const prompt = intentAnnotationPrompt('Mark the decisions.', rules);
  assert.match(prompt, /A visible approval decision/);
  assert.match(prompt, /A visible request to change the document/);
  assert.match(prompt, /Do not invent alternative labels, rename labels, or silently remap/);
  assert.match(intentAnnotationPrompt('Find interesting details.', []), /Choose labels dynamically/);
  assert.equal(parseIntentAnnotationOutput(JSON.stringify({ blocks: [block], warnings: [] }), 1, rules).blocks[0]?.label, 'Accepted');
  for (const label of ['accepted', ' Accepted', 'Approved', 'Other']) {
    assert.throws(() => parseIntentAnnotationOutput(JSON.stringify({ blocks: [{ ...block, label }], warnings: [] }), 1, rules), /outside the supplied rules/);
  }
});

test('streamed blocks must match declared labels exactly and final undeclared labels fail', () => {
  const seen: IntentAnnotationBlock[] = [];
  const scanner = new IntentBlockStream(1, (value) => seen.push(value), rules);
  scanner.push(`{"blocks":[${JSON.stringify({ ...block, label: 'accepted' })},${JSON.stringify(block)}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.label, 'Accepted');
  assert.equal(seen[0]?.id, 'intent-p1-b2', 'Rejected provisional labels must not change source block ordering.');
  assert.throws(() => scanner.finish(JSON.stringify({ blocks: [{ ...block, label: 'UNDECLARED' }], warnings: [] })), /outside the supplied rules/);
  const result = scanner.finish(JSON.stringify({ blocks: [block], warnings: [] }));
  assert.equal(result.blocks[0]?.label, 'Accepted');
});

test('malformed, duplicate, empty, and over-limit label rules fail as client input', () => {
  assert.deepEqual(validateIntentLabelRules(undefined), []);
  assert.deepEqual(validateIntentLabelRules([]), []);
  for (const invalid of [null, {}, [{ name: '', description: '' }], [{ name: '  ', description: '' }], [{ name: 'A', description: 'x' }, { name: 'A', description: 'y' }], [{ name: 'A', description: 'x'.repeat(1001) }], Array.from({ length: 25 }, (_, index) => ({ name: String(index), description: '' }))]) {
    assert.throws(() => validateIntentLabelRules(invalid), (error: unknown) => (error as { status: number }).status === 400);
  }
  assert.equal(validateIntentLabelRules(Array.from({ length: 24 }, (_, index) => ({ name: String(index), description: '' }))).length, 24);
});

test('empty model output is a clear failure instead of a misleading JSON parsing error', () => {
  assert.throws(() => parseIntentAnnotationOutput(' \n\t', 1), /model returned no annotation JSON/);
});
