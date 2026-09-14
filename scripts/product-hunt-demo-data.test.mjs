import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createProductHuntDemoWorkbook, demoGold, demoHeaders, demoTickets } from './product-hunt-demo-data.mjs';

test('Product Hunt feedback workbook contains only synthetic source rows and blank annotation fields', async () => {
  const bytes = await createProductHuntDemoWorkbook();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Feedback');

  assert.ok(sheet, 'the feedback worksheet should be present');
  assert.equal(sheet.rowCount, demoTickets.length + 1);
  assert.deepEqual(sheet.getRow(1).values.slice(1), demoHeaders);
  assert.equal(sheet.views[0]?.ySplit, 1);
  assert.deepEqual(demoGold.map((record) => record.ticketId), demoTickets.map(([ticketId]) => ticketId));

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    assert.deepEqual(sheet.getRow(rowNumber).values.slice(1, 5), demoTickets[rowNumber - 2]);
    assert.ok(sheet.getRow(rowNumber).values.slice(5).every((value) => value === null || value === undefined || value === ''), `output fields in row ${rowNumber} must remain unlabelled`);
  }

  const validIntents = new Set(['Billing', 'Account access', 'Bug', 'Performance', 'Cancellation', 'Privacy / security', 'Feature request', 'Delivery', 'Other']);
  const validSentiments = new Set(['Positive', 'Neutral', 'Negative', 'Mixed']);
  const validUrgencies = new Set(['P1 Critical', 'P2 High', 'P3 Normal', 'P4 Low', 'Unknown']);
  assert.ok(demoGold.every((record) => validIntents.has(record.intent) && validSentiments.has(record.sentiment) && validUrgencies.has(record.urgency) && ['Yes', 'No'].includes(record.needsReview)));
  assert.ok(demoGold.every((record, index) => demoTickets[index][3].includes(record.evidence)), 'gold evidence should be an exact source excerpt');
  assert.ok(demoGold.every((record) => record.needsReview === 'Yes' ? Boolean(record.reviewReason) : record.reviewReason === ''), 'human-review reasons should match the review flag');
  assert.ok(demoGold.filter((record) => record.needsReview === 'Yes').length >= 4, 'the sample should include meaningful human-review cases');
  assert.ok(demoTickets.every((ticket) => !ticket[3].includes('@')), 'the public sample must not contain email addresses');
});
