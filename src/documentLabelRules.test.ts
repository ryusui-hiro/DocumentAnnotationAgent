import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceHumanLabel, prepareHumanLabelRules } from './documentLabelRules';
import type { PaperBlock } from './paperOcrTypes';

const block = (label: string): PaperBlock => ({ id: '1', type: 'region', label, extractedText: 'Evidence', note: 'Context', bbox: { x: .1, y: .2, width: .3, height: .1 }, latex: null, uncertain: false, uncertaintyReason: '' });
test('only explicit human rows constrain labels; empty rules keep model-discovered labels dynamic', () => {
  const prepared = prepareHumanLabelRules([{ name: '', description: '' }]);
  assert.deepEqual(prepared, { rules: [] });
  assert.equal(enforceHumanLabel(block('A new model label'), prepared.rules).label, 'A new model label');
  assert.deepEqual(prepared.rules, [], 'discovering a model label does not create a future constraint');
});
test('human labels enforce exact spelling and preserve their definitions', () => {
  const prepared = prepareHumanLabelRules([{ name: 'Revenue', description: 'Reported revenue only; exclude forecasts.' }, { name: '要確認', description: 'Ambiguous values.' }]);
  assert.equal(prepared.issue, undefined);
  assert.equal(enforceHumanLabel(block('Revenue'), prepared.rules).label, 'Revenue');
  assert.equal(enforceHumanLabel(block('要確認'), prepared.rules).label, '要確認');
  for (const name of ['revenue', 'Revenue ', 'Other']) assert.throws(() => enforceHumanLabel(block(name), prepared.rules), /outside your defined labels/);
  assert.equal(prepared.rules[0]?.description, 'Reported revenue only; exclude forecasts.');
});
test('incomplete and duplicate human rules cannot be silently ignored', () => {
  assert.equal(prepareHumanLabelRules([{ name: '', description: 'A definition without a name' }]).issue, 'missing_name');
  assert.equal(prepareHumanLabelRules([{ name: 'Same', description: 'A' }, { name: 'Same', description: 'B' }]).issue, 'duplicate_name');
});
