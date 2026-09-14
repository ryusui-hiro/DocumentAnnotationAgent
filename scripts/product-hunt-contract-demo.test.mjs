import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { preview } from 'document-svg';

test('Product Hunt live contract source has fourteen unlabeled clauses across eleven pages', async () => {
  const report = await preview(resolve('public/demos/product-hunt-termination-contract.pdf'));
  assert.equal(report.pageCount, 11);

  const pageTexts = report.pages.map((page) => [...page.svg.matchAll(/<text[^>]*aria-label="([^"]+)"/gu)]
    .map((match) => match[1]?.replaceAll('&amp;', '&') ?? '').join('\n'));
  const pageText = pageTexts.join('\n');
  const clauseNumbers = new Set([...pageText.matchAll(/\b8\.\d{1,2}\b/gu)].map((match) => match[0]));
  assert.equal(clauseNumbers.size, 14, 'the demo agreement must expose every intended termination clause in extracted PDF text');
  assert.doesNotMatch(pageText, /\b(?:HIGH|MEDIUM|LOW)\s+RISK\b/iu, 'the live source must not include the expected annotation labels');
  assert.match(report.pages[0]?.svg ?? '', /8\.1/u, 'the opening page should contain a visible example clause');
  assert.match(report.pages[3]?.svg ?? '', /8\.5/u, 'page four should contain the ambiguous review clause');
  assert.match(report.pages[10]?.svg ?? '', /8\.13/u, 'the final page should contain a later-page rule application target');

  assert.deepEqual(pageTexts.map((text) => [...text.matchAll(/\b8\.\d{1,2}\b/gu)].map((match) => match[0])), [
    ['8.1', '8.2'], ['8.3'], ['8.4'], ['8.5', '8.6'], ['8.7'], ['8.8'], ['8.9'], ['8.10'], ['8.11'], ['8.12'], ['8.13', '8.14'],
  ], 'the page-by-page clause sequence should preserve the review demo path');
  assert.ok(pageTexts.every((text) => (text.match(/\b[\w'-]+\b/gu)?.length ?? 0) >= 60), 'every page should contain substantive, selectable agreement text rather than blank filler');
  assert.match(pageTexts[0] ?? '', /Northwind House LLC/u, 'the opening page should identify the fictional customer');
  assert.match(pageTexts[4] ?? '', /Customer Data/u, 'the security schedule should provide context for its termination clause');
  assert.match(pageTexts[6] ?? '', /72 hours/u, 'the incident-reporting page should make its deadline legible');
  assert.match(pageTexts[10] ?? '', /ninety days/u, 'the closing page should include transition context');
});
