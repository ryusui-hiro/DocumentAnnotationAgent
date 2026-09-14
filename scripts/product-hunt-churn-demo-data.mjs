import ExcelJS from 'exceljs';

export const churnHeaders = ['name', 'plan', 'last_login', 'tickets', 'monthly_usage', 'Churn Risk'];

// A fixed 2026-09-01 snapshot of synthetic accounts. The last column is the
// only annotation field and intentionally has no prefilled labels.
export const churnCustomers = [
  ['Sample Customer 001', 'Starter', '2026-07-01', 1, 0.3],
  ['Sample Customer 002', 'Team', '2026-07-18', 4, 1.2],
  ['Sample Customer 003', 'Pro', '2026-07-25', 5, 0.7],
  ['Sample Customer 004', 'Team', '2026-07-28', 6, 1.5],
  ['Sample Customer 005', 'Starter', '2026-07-30', 3, 0.8],
  ['Sample Customer 006', 'Pro', '2026-08-02', 5, 2.5],
  ['Sample Customer 007', 'Starter', '2026-08-03', 1, 5],
  ['Sample Customer 008', 'Team', '2026-08-08', 2, 3.5],
  ['Sample Customer 009', 'Enterprise', '2026-08-15', 0, 8],
  ['Sample Customer 010', 'Pro', '2026-08-18', 3, 3.2],
  ['Sample Customer 011', 'Team', '2026-08-20', 2, 4],
  ['Sample Customer 012', 'Starter', '2026-08-23', 4, 15],
  ['Sample Customer 013', 'Team', '2026-08-24', 1, 8],
  ['Sample Customer 014', 'Enterprise', '2026-08-25', 0, 10],
  ['Sample Customer 015', 'Pro', '2026-08-27', 1, 12],
  ['Sample Customer 016', 'Starter', '2026-08-28', 0, 15],
  ['Sample Customer 017', 'Team', '2026-08-30', 1, 9],
  ['Sample Customer 018', 'Enterprise', '2026-08-31', 0, 16],
];

export async function createProductHuntChurnWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Annotation Studio';
  workbook.subject = 'Synthetic customer records for churn-risk classification';
  workbook.title = 'Customer churn-risk demo';
  workbook.created = new Date('2026-01-01T00:00:00.000Z');
  workbook.modified = new Date('2026-01-01T00:00:00.000Z');
  workbook.properties.date1904 = false;

  const sheet = workbook.addWorksheet('Customers', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.addRow(churnHeaders);
  for (const [name, plan, lastLogin, tickets, monthlyUsage] of churnCustomers) {
    sheet.addRow([name, plan, new Date(`${lastLogin}T00:00:00.000Z`), tickets, monthlyUsage, null]);
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B67' } };
  sheet.getRow(1).height = 28;
  sheet.columns = [
    { key: 'name', width: 25 },
    { key: 'plan', width: 16 },
    { key: 'lastLogin', width: 16 },
    { key: 'tickets', width: 12 },
    { key: 'monthlyUsage', width: 18 },
    { key: 'churnRisk', width: 18 },
  ];
  sheet.getColumn(3).numFmt = 'yyyy-mm-dd';
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    sheet.getRow(row).alignment = { vertical: 'middle' };
  }
  sheet.autoFilter = { from: 'A1', to: `F${sheet.rowCount}` };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
