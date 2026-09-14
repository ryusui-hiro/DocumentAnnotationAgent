import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocumentReaderOutput } from './documentReader';

const evidence = {
  excerpt: 'Revenue: 120', description: 'The revenue row.',
  boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 }, readingPriority: 'medium',
};
const output = { pageSummary: 'Financial summary', evidenceBlocks: [evidence], uncertainties: [] };

test('maps image-relative Reader evidence into full-page coordinates for a scrolled crop', () => {
  const parsed = parseDocumentReaderOutput(output, { x: 0.2, y: 0.4, width: 0.5, height: 0.4 });
  assert.deepEqual(parsed?.evidenceBlocks[0]?.boundingBox, {
    x: 0.2 + 0.1 * 0.5, y: 0.4 + 0.2 * 0.4, width: 0.5 * 0.5, height: 0.1 * 0.4,
  });
  assert.equal(parsed?.evidenceBlocks[0]?.excerpt, evidence.excerpt);
  assert.deepEqual(parseDocumentReaderOutput(output), output, 'a full-page image needs no coordinate change');
});

test('preserves evidence but omits unlocatable, empty or out-of-image Reader boxes', () => {
  for (const boundingBox of [null, { x: 0.8, y: 0.2, width: 0.4, height: 0.2 }, { x: 0.1, y: 0.2, width: 0, height: 0.1 }]) {
    const parsed = parseDocumentReaderOutput({ ...output, evidenceBlocks: [{ ...evidence, boundingBox }] });
    assert.equal(parsed?.evidenceBlocks[0]?.boundingBox, null);
    assert.equal(parsed?.evidenceBlocks[0]?.excerpt, evidence.excerpt);
  }
  assert.equal(parseDocumentReaderOutput({ ...output, commands: [] }), null);
  assert.equal(parseDocumentReaderOutput(output, { x: 0.8, y: 0, width: 0.4, height: 1 }), null);
  assert.equal(parseDocumentReaderOutput(output, { x: 0, y: 0, width: Number.NaN, height: 1 }), null);
});
