import assert from 'node:assert/strict';
import test from 'node:test';
import { cropPixels, excerptsMarkdown, extractableAnnotations, safeExtractionName } from './extraction';
import type { Annotation } from './types';

const mark = (patch: Partial<Annotation> = {}): Annotation => ({ id: 'a', pageNumber: 1, x: .1, y: .2, width: .3, height: .2, label: '仕様', note: '注釈', color: '#147f7c', source: 'manual', ...patch });

test('extractions omit pending items and retain approved AI evidence in page order', () => {
  const rows = extractableAnnotations([mark({ id: 'pending', requiresReview: true, source: 'ai' }), mark({ id: 'later', pageNumber: 2 }), mark({ id: 'approved', source: 'ai', requiresReview: true, reviewedByHuman: true })]);
  assert.deepEqual(rows.map((item) => item.id), ['approved', 'later']);
});

test('crop covers fractional edge pixels, clamps to page, and rejects empty or nonfinite regions', () => {
  assert.deepEqual(cropPixels({ x: -.01, y: .101, width: .512, height: .91 }, 1000, 1000), { left: 0, top: 101, width: 502, height: 899 });
  for (const box of [{ x: 1.1, y: 0, width: .2, height: .2 }, { x: 0, y: 0, width: NaN, height: .2 }, { x: 0, y: 0, width: 0, height: .2 }]) assert.throws(() => cropPixels(box, 100, 100));
});

test('archive labels cannot create paths and excerpt Markdown cannot inject HTML or remote images', () => {
  assert.equal(safeExtractionName('../../重要:表?'), '-..-重要-表-');
  const note = excerptsMarkdown('元文書.pdf', [mark({ excerpt: '<img src=x>\n![tracking](https://example.test)', note: '確認済み' }), mark({ requiresReview: true, source: 'ai', note: 'pending secret' })]);
  assert.match(note, /1 件の確定注釈/);
  assert.match(note, /&lt;img src=x&gt;/);
  assert.ok(note.includes('\\!\\[tracking\\]'));
  assert.ok(!note.includes('pending secret'));
  assert.match(note, /確認済み/);
});
