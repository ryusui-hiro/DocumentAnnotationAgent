import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { preview } from 'document-svg';
import { extractPositionedTextBlocks, extractPositionedTextLines, findPositionedTextTargets, parsePositionedTextLines } from './textTarget';

test('resolves PDF text transforms and glyph positions into stable page coordinates', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><text x="0" y="0" transform="matrix(1 0 0 1 60 200)" aria-label="SAFETY WARNING"><tspan font-size="20" font-weight="700"><tspan x="0" y="0">S</tspan><tspan x="12" y="0">A</tspan><tspan x="24" y="0">F</tspan><tspan x="36" y="0">E</tspan><tspan x="48" y="0">T</tspan><tspan x="60" y="0">Y</tspan><tspan x="72" y="0"> </tspan><tspan x="80" y="0">W</tspan><tspan x="96" y="0">A</tspan><tspan x="108" y="0">R</tspan><tspan x="120" y="0">N</tspan><tspan x="132" y="0">I</tspan><tspan x="140" y="0">N</tspan><tspan x="152" y="0">G</tspan></tspan></text></svg>';
  const lines = extractPositionedTextLines(svg);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[x=0\.100, y=0\.225, w=0\.[\d]+, h=0\.031\] SAFETY WARNING$/);
  const block = extractPositionedTextBlocks(svg)[0]!;
  assert.equal(block.characterBoxes?.length, 'SAFETY WARNING'.length);
  assert.equal(block.fontSize, 20);
  assert.equal(block.bold, true);
  assert.ok(block.boundingBox.x > 0.09);
  assert.ok(block.boundingBox.y > 0.22);
});

test('parses positioned line headers with bounded linear string operations', () => {
  const [block] = parsePositionedTextLines(['[x=0.125, y=0.25, w=0.5, h=0.05] Bounded source text']);
  assert.deepEqual(block?.boundingBox, { x: 0.125, y: 0.25, width: 0.5, height: 0.05 });
  assert.equal(block?.text, 'Bounded source text');
  assert.deepEqual(parsePositionedTextLines([`[x=${' '.repeat(50_000)}0.1, y=0.2, w=0.3, h=0.04] hostile text`]), []);
});

test('uses document-svg PDF text matrices when locating selectable source text', async () => {
  const report = await preview(resolve('public/demo-specification.pdf'));
  const blocks = extractPositionedTextBlocks(report.pages[0]!.svg);
  const title = blocks.find((block) => block.text === 'FIELDNOTES / ENGINEERING');
  assert.ok(title);
  assert.ok(Math.abs(title.boundingBox.x - 48 / 612) < 0.002);
  assert.ok(title.boundingBox.y > 0.03 && title.boundingBox.y < 0.05);

  const target = findPositionedTextTargets(blocks, 'MAX FASTENING TORQUE');
  assert.equal(target.length, 1);
  assert.equal(target[0]?.occurrences, 1);
  assert.ok(target[0]!.boundingBox.x > 0.58);
  assert.ok(target[0]!.boundingBox.y > 0.29 && target[0]!.boundingBox.y < 0.34);
  assert.ok(target[0]!.fragments.length >= 1);
  assert.equal(target[0]?.textAnchor.quote.exact, 'MAX FASTENING TORQUE');
});

test('selects a unique phrase across positioned text lines with separate fragments and quote context', () => {
  const matches = findPositionedTextTargets([
    '[x=0.100, y=0.100, w=0.300, h=0.030] Disconnect the power supply',
    '[x=0.100, y=0.140, w=0.350, h=0.030] before servicing the fan.',
  ], 'POWER SUPPLY before servicing');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.occurrences, 1);
  assert.deepEqual(matches[0]?.boundingBox, { x: 0.1, y: 0.1, width: 0.30000000000000004, height: 0.07 });
  assert.deepEqual(matches[0]?.fragments.map((fragment) => fragment.y), [0.1, 0.14]);
  assert.equal(matches[0]?.excerpt, 'power supply before servicing');
  assert.equal(matches[0]?.textAnchor.quote.exact, 'power supply before servicing');
  assert.equal(matches[0]?.textAnchor.quote.prefix, 'disconnect the ');
  assert.equal(matches[0]?.textAnchor.quote.suffix, ' the fan.');
  assert.deepEqual(matches[0]?.textAnchor.position, { start: 15, end: 44, unit: 'normalized-page-text' });
  assert.equal(matches[0]?.lineEnd, 1);
});

test('keeps repeated text matches as separate ambiguous targets', () => {
  const matches = findPositionedTextTargets([
    '[x=0.100, y=0.100, w=0.300, h=0.030] Maximum torque is 12 N-m.',
    '[x=0.100, y=0.300, w=0.300, h=0.030] Maximum torque is 12 N-m.',
  ], '12 N-m');
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.occurrences === 2));
  assert.notEqual(matches[0]?.boundingBox.y, matches[1]?.boundingBox.y);
});

test('does not offer text selection when no positioned text is available', () => {
  assert.deepEqual(findPositionedTextTargets(['Scanned page with no extracted positions.'], 'scanned page'), []);
});
