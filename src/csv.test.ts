import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeCsvCell } from './csv';

test('CSV treats formula-like document text as literal text even after leading whitespace', () => {
  assert.equal(escapeCsvCell('=HYPERLINK("https://example.test", "Open")'), '"\'=HYPERLINK(""https://example.test"", ""Open"")"');
  assert.equal(escapeCsvCell('+SUM(A1:A2)'), '"\'+SUM(A1:A2)"');
  assert.equal(escapeCsvCell('-1+2'), '"\'-1+2"');
  assert.equal(escapeCsvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
  assert.equal(escapeCsvCell('  \t=1+2'), '"\'  \t=1+2"');
  assert.equal(escapeCsvCell('\tany text'), '"\'\tany text"');
  assert.equal(escapeCsvCell('\r\n=1+2'), '"\'\r\n=1+2"');
});

test('CSV preserves ordinary text, embedded quotes, newlines and genuine numeric values', () => {
  assert.equal(escapeCsvCell('金額, "要確認"\n担当者の注釈'), '"金額, ""要確認""\n担当者の注釈"');
  assert.equal(escapeCsvCell(-12.5), '"-12.5"');
  assert.equal(escapeCsvCell(0), '"0"');
  assert.equal(escapeCsvCell(false), '"false"');
  assert.equal(escapeCsvCell(null), '""');
  assert.equal(escapeCsvCell(undefined), '""');
  assert.equal(escapeCsvCell({ text: '=1+2' }), '"{""text"":""=1+2""}"');
});
