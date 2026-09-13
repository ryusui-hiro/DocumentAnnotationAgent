import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPositionedTextLines, findPositionedTextTargets } from './textTarget';

test('extracts normalized text boxes from SVG without turning markup into text', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><text x="60" y="200" font-size="20">SAFETY <tspan>WARNING</tspan></text></svg>';
  const lines = extractPositionedTextLines(svg);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[x=0\.100, y=0\.225, w=0\.243, h=0\.031\] SAFETY WARNING$/);
});

test('selects a unique phrase across positioned text lines and unions their boxes', () => {
  const matches = findPositionedTextTargets([
    '[x=0.100, y=0.100, w=0.300, h=0.030] Disconnect the power supply',
    '[x=0.100, y=0.140, w=0.350, h=0.030] before servicing the fan.',
  ], 'POWER SUPPLY before servicing');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.occurrences, 1);
  assert.deepEqual(matches[0]?.boundingBox, { x: 0.1, y: 0.1, width: 0.35, height: 0.07 });
  assert.match(matches[0]?.excerpt ?? '', /Disconnect the power supply before servicing/);
});

test('keeps repeated text matches as separate ambiguous targets', () => {
  const matches = findPositionedTextTargets([
    '[x=0.100, y=0.100, w=0.300, h=0.030] Maximum torque is 12 N-m.',
    '[x=0.100, y=0.300, w=0.300, h=0.030] Maximum torque is 12 N-m.',
  ], '12 N-m');
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.occurrences === 1));
  assert.notEqual(matches[0]?.boundingBox.y, matches[1]?.boundingBox.y);
});

test('does not offer text selection when no positioned text is available', () => {
  assert.deepEqual(findPositionedTextTargets(['Scanned page with no extracted positions.'], 'scanned page'), []);
});
