import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createProductHuntChurnWorkbook, churnCustomers, churnHeaders } from './product-hunt-churn-demo-data.mjs';

test('Product Hunt churn workbook contains synthetic customer inputs and one blank output column', async () => {
  const bytes = await createProductHuntChurnWorkbook();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Customers');

  assert.ok(sheet, 'the Customers worksheet should be present');
  assert.equal(sheet.rowCount, churnCustomers.length + 1);
  assert.deepEqual(sheet.getRow(1).values.slice(1), churnHeaders);
  assert.deepEqual(churnHeaders, ['name', 'plan', 'last_login', 'tickets', 'monthly_usage', 'Churn Risk']);
  assert.equal(sheet.views[0]?.ySplit, 1);

  const snapshot = new Date('2026-09-01T00:00:00Z');
  const groups = { High: 0, Medium: 0, Low: 0 };
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values.slice(1);
    const [name, plan, lastLogin, tickets, monthlyUsage, churnRisk] = values;
    assert.deepEqual([name, plan, lastLogin instanceof Date ? lastLogin.toISOString().slice(0, 10) : lastLogin, tickets, monthlyUsage], churnCustomers[rowNumber - 2]);
    assert.ok(churnRisk === null || churnRisk === undefined || churnRisk === '', `Churn Risk must be blank in row ${rowNumber}`);
    assert.equal(typeof name, 'string');
    assert.equal(typeof plan, 'string');
    assert.ok(lastLogin instanceof Date, `last_login in row ${rowNumber} should be a typed Excel date`);
    assert.equal(sheet.getCell(rowNumber, 3).numFmt, 'yyyy-mm-dd');
    assert.ok(lastLogin < snapshot, `last_login in row ${rowNumber} must precede the snapshot`);
    assert.ok(Number.isInteger(tickets) && tickets >= 0);
    assert.ok(typeof monthlyUsage === 'number' && monthlyUsage >= 0);
    assert.doesNotMatch(`${name} ${plan}`, /@|\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/u, 'the synthetic sample must not contain contact details');

    const daysInactive = (snapshot.getTime() - lastLogin.getTime()) / 86_400_000;
    if ((daysInactive >= 30 && monthlyUsage < 2) || (tickets >= 5 && monthlyUsage < 3)) groups.High += 1;
    else if (daysInactive <= 14 && monthlyUsage >= 8 && tickets <= 1) groups.Low += 1;
    else groups.Medium += 1;
  }
  assert.deepEqual(groups, { High: 6, Medium: 6, Low: 6 }, 'the sample should contain balanced, rubric-supported examples for all three labels');
});
