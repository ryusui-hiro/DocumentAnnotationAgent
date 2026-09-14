import ExcelJS from 'exceljs';

export const demoHeaders = [
  'Ticket ID', 'Channel', 'Plan', 'Customer feedback',
  'Intent', 'Sentiment', 'Urgency', 'Evidence quote', 'Human review', 'Review reason',
];

export const demoTickets = [
  ['FB-001', 'Email', 'Team', 'I was charged twice for the same annual renewal. The invoice only shows one renewal, and I have not received a refund.'],
  ['FB-002', 'In-app', 'Pro', 'I received a sign-in alert from a device I do not recognize, and then my password stopped working. Please lock the account while I check this.'],
  ['FB-003', 'Chat', 'Starter', 'The new onboarding checklist was clear and I finished setup in ten minutes. Thanks for making this easier.'],
  ['FB-004', 'Email', 'Team', 'I cannot receive the one-time code, so nobody on our team can sign in. We tried both email and SMS twice.'],
  ['FB-005', 'In-app', 'Pro', 'The export works in the browser, but the desktop app closes whenever I export a large report. Reopening the report takes a while.'],
  ['FB-006', 'Email', 'Starter', 'How do I stop the plan from renewing next month? I still want to use it until the end of this billing period.'],
  ['FB-007', 'Chat', 'Team', 'Since yesterday, saved invoices disappeared from our workspace after sync. We cannot find them in search or in the archive.'],
  ['FB-008', 'In-app', 'Pro', 'The billing screen says “pending” for the renewal. My bank has not posted a completed charge yet. Is this expected?'],
  ['FB-009', 'Email', 'Team', 'The filter resets every time I open a saved view. I like the dashboard, but I have to rebuild the same filter each morning.'],
  ['FB-010', 'Chat', 'Starter', 'Could you add a webhook when a report is ready? Our team currently checks the page manually.'],
  ['FB-011', 'Email', 'Pro', 'I saw another company name in the invite preview before sending a teammate an invitation. I closed the dialog immediately.'],
  ['FB-012', 'In-app', 'Team', 'Please delete our workspace data and send us a copy first. The contract says deletion can take up to 30 days, but I need to know what happens to the export request.'],
  ['FB-013', 'Chat', 'Starter', 'Nothing works.'],
  ['FB-014', 'Email', 'Pro', 'Every French CSV export replaces accented characters with question marks. Opening the same report in the browser looks fine.'],
  ['FB-015', 'In-app', 'Team', 'The mobile app takes about 40 seconds to load a report. The same report loads in five seconds on desktop, so I can use that for now.'],
  ['FB-016', 'Email', 'Starter', 'I cannot tell whether my trial ends today or tomorrow because the account page shows two different dates.'],
];

export const demoGold = [
  { ticketId: 'FB-001', intent: 'Billing', sentiment: 'Negative', urgency: 'P2 High', evidence: 'I was charged twice for the same annual renewal.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-002', intent: 'Privacy / security', sentiment: 'Negative', urgency: 'P1 Critical', evidence: 'I received a sign-in alert from a device I do not recognize', needsReview: 'Yes', reviewReason: 'The suspected compromise is reported but not independently verified; investigate the account before treating it as confirmed.' },
  { ticketId: 'FB-003', intent: 'Other', sentiment: 'Positive', urgency: 'P4 Low', evidence: 'I finished setup in ten minutes.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-004', intent: 'Account access', sentiment: 'Negative', urgency: 'P2 High', evidence: 'nobody on our team can sign in.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-005', intent: 'Bug', sentiment: 'Negative', urgency: 'P3 Normal', evidence: 'the desktop app closes whenever I export a large report.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-006', intent: 'Cancellation', sentiment: 'Neutral', urgency: 'P4 Low', evidence: 'How do I stop the plan from renewing next month?', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-007', intent: 'Bug', sentiment: 'Negative', urgency: 'P2 High', evidence: 'saved invoices disappeared from our workspace after sync.', needsReview: 'Yes', reviewReason: 'The report indicates missing invoices but does not confirm permanent data loss; investigate recovery before assigning a critical incident.' },
  { ticketId: 'FB-008', intent: 'Billing', sentiment: 'Neutral', urgency: 'P4 Low', evidence: 'My bank has not posted a completed charge yet.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-009', intent: 'Bug', sentiment: 'Mixed', urgency: 'P3 Normal', evidence: 'The filter resets every time I open a saved view.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-010', intent: 'Feature request', sentiment: 'Neutral', urgency: 'P4 Low', evidence: 'Could you add a webhook when a report is ready?', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-011', intent: 'Privacy / security', sentiment: 'Negative', urgency: 'P2 High', evidence: 'I saw another company name in the invite preview', needsReview: 'Yes', reviewReason: 'The report may indicate cross-customer disclosure, but the scope and affected data are unknown; investigate.' },
  { ticketId: 'FB-012', intent: 'Privacy / security', sentiment: 'Neutral', urgency: 'P3 Normal', evidence: 'Please delete our workspace data and send us a copy first.', needsReview: 'Yes', reviewReason: 'The requested export/deletion sequence and applicable retention terms are unclear from this ticket.' },
  { ticketId: 'FB-013', intent: 'Other', sentiment: 'Negative', urgency: 'Unknown', evidence: 'Nothing works.', needsReview: 'Yes', reviewReason: 'There is not enough detail to identify the issue, impact, or urgency.' },
  { ticketId: 'FB-014', intent: 'Bug', sentiment: 'Negative', urgency: 'P3 Normal', evidence: 'replaces accented characters with question marks.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-015', intent: 'Performance', sentiment: 'Negative', urgency: 'P3 Normal', evidence: 'The mobile app takes about 40 seconds to load a report.', needsReview: 'No', reviewReason: '' },
  { ticketId: 'FB-016', intent: 'Billing', sentiment: 'Neutral', urgency: 'Unknown', evidence: 'the account page shows two different dates.', needsReview: 'Yes', reviewReason: 'The conflicting trial-end dates need clarification before assigning billing urgency.' },
];

export async function createProductHuntDemoWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Annotation Studio';
  workbook.subject = 'Synthetic customer feedback for LLM annotation';
  workbook.title = 'Customer feedback triage demo';
  workbook.created = new Date('2026-01-01T00:00:00.000Z');
  workbook.modified = new Date('2026-01-01T00:00:00.000Z');
  workbook.properties.date1904 = false;

  const sheet = workbook.addWorksheet('Feedback', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: 'J17' },
  });
  sheet.addRow(demoHeaders);
  for (const ticket of demoTickets) sheet.addRow([...ticket, '', '', '', '', '', '']);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B67' } };
  sheet.getRow(1).height = 28;
  sheet.columns = [
    { key: 'ticketId', width: 14 }, { key: 'channel', width: 13 }, { key: 'plan', width: 12 },
    { key: 'feedback', width: 76 }, { key: 'intent', width: 23 }, { key: 'sentiment', width: 16 },
    { key: 'urgency', width: 16 }, { key: 'evidence', width: 48 }, { key: 'humanReview', width: 16 },
    { key: 'reviewReason', width: 52 },
  ];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    sheet.getRow(row).alignment = { vertical: 'top', wrapText: true };
    sheet.getRow(row).height = 34;
  }
  sheet.autoFilter = { from: 'A1', to: `J${sheet.rowCount}` };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
