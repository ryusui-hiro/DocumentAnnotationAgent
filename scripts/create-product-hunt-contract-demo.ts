import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const outputPath = resolve('public/demos/product-hunt-termination-contract.pdf');
const pageWidth = 612;
const pageHeight = 792;
const regular = StandardFonts.Helvetica;
const bold = StandardFonts.HelveticaBold;
const ink = rgb(0.11, 0.17, 0.22);
const muted = rgb(0.38, 0.46, 0.52);
const navy = rgb(0.08, 0.16, 0.23);
const teal = rgb(0.03, 0.40, 0.40);
const tealPale = rgb(0.91, 0.96, 0.95);
const gold = rgb(0.78, 0.55, 0.20);
const goldPale = rgb(0.99, 0.96, 0.88);
const pale = rgb(0.96, 0.97, 0.98);
const line = rgb(0.84, 0.88, 0.90);
const white = rgb(1, 1, 1);

const pdf = await PDFDocument.create();
const regularFont = await pdf.embedFont(regular);
const boldFont = await pdf.embedFont(bold);
const fixedDate = new Date('2026-01-01T00:00:00.000Z');
pdf.setTitle('Northwind House - Managed Analytics Services Agreement | Review Copy');
pdf.setAuthor('Astra Annotator synthetic sample');
pdf.setSubject('Eleven-page fictional services agreement review packet with fourteen termination provisions');
pdf.setKeywords(['fictional', 'synthetic', 'services agreement', 'termination review', 'annotation demo']);
pdf.setCreator('Astra Annotator deterministic sample generator');
pdf.setProducer('Astra Annotator deterministic sample generator');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

function drawText(page: PDFPage, value: string, x: number, top: number, size: number, font: PDFFont = regularFont, color = ink) {
  page.drawText(value, { x, y: pageHeight - top - size, size, font, color });
}

function drawRule(page: PDFPage, top: number, x1 = 48, x2 = 564, color = line, thickness = 0.8) {
  page.drawLine({ start: { x: x1, y: pageHeight - top }, end: { x: x2, y: pageHeight - top }, thickness, color });
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let current = '';
  for (const word of value.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function drawParagraph(page: PDFPage, value: string, x: number, top: number, width: number, size = 9.4, color = ink, font: PDFFont = regularFont, leading = 1.42) {
  const lineHeight = size * leading;
  const lines = wrapText(value, font, size, width);
  lines.forEach((text, index) => drawText(page, text, x, top + index * lineHeight, size, font, color));
  return top + lines.length * lineHeight;
}

function drawHeader(page: PDFPage, pageNumber: number, section: string, title: string, subtitle: string) {
  page.drawRectangle({ x: 0, y: pageHeight - 9, width: pageWidth, height: 9, color: navy });
  page.drawRectangle({ x: 48, y: pageHeight - 39, width: 22, height: 22, color: teal });
  drawText(page, 'N', 54, 43, 10, boldFont, white);
  drawText(page, 'NORTHWIND HOUSE', 78, 27, 9, boldFont, navy);
  drawText(page, 'MANAGED SERVICES AGREEMENT', 78, 40, 7.5, regularFont, muted);
  drawText(page, 'REVIEW COPY  /  FICTIONAL', 411, 31, 7.5, boldFont, teal);
  drawText(page, section.toUpperCase(), 48, 62, 7.8, boldFont, teal);
  drawText(page, title, 48, 78, 19, boldFont, navy);
  drawText(page, subtitle, 48, 105, 8.8, regularFont, muted);
  drawRule(page, 126);
  drawRule(page, 752);
  drawText(page, 'Synthetic demonstration sample. All parties, dates, and terms are invented.', 48, 762, 7.2, regularFont, muted);
  drawText(page, `${String(pageNumber).padStart(2, '0')}  /  11`, 520, 762, 7.2, boldFont, muted);
}

function drawSectionHeading(page: PDFPage, number: string, title: string, top: number, width = 516) {
  drawText(page, number, 48, top + 1, 8, boldFont, teal);
  drawText(page, title, 85, top - 1, 12.4, boldFont, navy);
  drawRule(page, top + 21, 85, 48 + width);
  return top + 31;
}

function drawLabel(page: PDFPage, value: string, x: number, top: number, color = teal) {
  drawText(page, value.toUpperCase(), x, top, 7.2, boldFont, color);
}

function drawPanel(page: PDFPage, x: number, top: number, width: number, height: number, fill = pale, stroke = line) {
  page.drawRectangle({
    x,
    y: pageHeight - top - height,
    width,
    height,
    color: fill,
    borderColor: stroke,
    borderWidth: 0.7,
  });
}

function drawTable(page: PDFPage, top: number, widths: number[], headers: string[], rows: string[][], options: { rowHeight?: number; fontSize?: number; headerFill?: ReturnType<typeof rgb> } = {}) {
  const fontSize = options.fontSize ?? 8.2;
  const rowHeight = options.rowHeight ?? 34;
  const x = 48;
  const width = widths.reduce((sum, item) => sum + item, 0);
  const headerHeight = 25;
  page.drawRectangle({ x, y: pageHeight - top - headerHeight, width, height: headerHeight, color: options.headerFill ?? navy });
  let currentX = x;
  headers.forEach((header, index) => {
    drawText(page, header.toUpperCase(), currentX + 9, top + 8, 7, boldFont, white);
    currentX += widths[index] ?? 0;
  });
  let currentTop = top + headerHeight;
  rows.forEach((row, rowIndex) => {
    const cellLines = row.map((value, index) => wrapText(value, index === 0 ? boldFont : regularFont, fontSize, (widths[index] ?? 0) - 18));
    const contentLines = Math.max(...cellLines.map((lines) => lines.length), 1);
    const actualHeight = Math.max(rowHeight, 12 + contentLines * (fontSize * 1.25));
    page.drawRectangle({
      x,
      y: pageHeight - currentTop - actualHeight,
      width,
      height: actualHeight,
      color: rowIndex % 2 === 0 ? white : pale,
      borderColor: line,
      borderWidth: 0.45,
    });
    currentX = x;
    row.forEach((_, cellIndex) => {
      (cellLines[cellIndex] ?? []).forEach((cellLine, lineIndex) => {
        drawText(page, cellLine, currentX + 9, currentTop + 7 + lineIndex * fontSize * 1.25, fontSize, cellIndex === 0 ? boldFont : regularFont, cellIndex === 0 ? navy : ink);
      });
      if (cellIndex > 0) {
        page.drawLine({ start: { x: currentX, y: pageHeight - currentTop }, end: { x: currentX, y: pageHeight - currentTop - actualHeight }, thickness: 0.45, color: line });
      }
      currentX += widths[cellIndex] ?? 0;
    });
    currentTop += actualHeight;
  });
  return currentTop;
}

function drawClause(page: PDFPage, number: string, title: string, body: string, top: number, options: { width?: number; fill?: ReturnType<typeof rgb>; accent?: ReturnType<typeof rgb>; size?: number } = {}) {
  const width = options.width ?? 516;
  const accentColor = options.accent ?? teal;
  const size = options.size ?? 9.5;
  const titleX = 104;
  const textWidth = width - 69;
  const bodyTop = top + 26;
  const bodyLines = wrapText(body, regularFont, size, textWidth);
  const end = bodyTop + bodyLines.length * size * 1.4;
  const cardHeight = end - top + 12;
  if (options.fill) {
    page.drawRectangle({ x: 48, y: pageHeight - top - cardHeight, width, height: cardHeight, color: options.fill });
    page.drawRectangle({ x: 48, y: pageHeight - top - cardHeight, width: 3, height: cardHeight, color: accentColor });
  }
  page.drawRectangle({ x: 48, y: pageHeight - top - 22, width: 45, height: 20, color: accentColor });
  drawText(page, number, 55, top + 4, 8, boldFont, white);
  drawText(page, title, titleX, top + 1, 11.2, boldFont, navy);
  drawParagraph(page, body, titleX, bodyTop, textWidth, size, ink, regularFont, 1.4);
  if (!options.fill) drawRule(page, end + 7, titleX, 48 + width);
  return top + cardHeight + 9;
}

function drawMetricCard(page: PDFPage, x: number, top: number, width: number, label: string, value: string, detail: string) {
  drawPanel(page, x, top, width, 67, white, line);
  drawLabel(page, label, x + 10, top + 9, muted);
  drawText(page, value, x + 10, top + 23, 14, boldFont, navy);
  drawParagraph(page, detail, x + 10, top + 44, width - 20, 7.4, muted, regularFont, 1.2);
}

function makePage(pageNumber: number, section: string, title: string, subtitle: string) {
  const page = pdf.addPage([pageWidth, pageHeight]);
  drawHeader(page, pageNumber, section, title, subtitle);
  return page;
}

// Page 1: a real document opening page, with the parties, commercial terms, review brief, and two contrasting exit rights.
{
  const page = makePage(1, 'Master services agreement', 'Managed Analytics Services Agreement', 'Review packet  |  Effective January 1, 2026  |  Prepared for annotation workflow demonstration');
  drawPanel(page, 48, 141, 516, 73, pale, line);
  drawLabel(page, 'CUSTOMER', 62, 153);
  drawText(page, 'Northwind House LLC', 62, 166, 10.2, boldFont, navy);
  drawLabel(page, 'PROVIDER', 235, 153);
  drawText(page, 'Lumenfield Works, Inc.', 235, 166, 10.2, boldFont, navy);
  drawLabel(page, 'INITIAL TERM', 424, 153);
  drawText(page, 'One year', 424, 166, 10.2, boldFont, navy);
  drawText(page, 'Services: analytics dashboards, data pipelines, support, and regional hosting.', 62, 190, 8.2, regularFont, muted);

  let cursor = drawSectionHeading(page, 'INFO', 'Parties and contract map', 231);
  cursor = drawParagraph(page, 'Northwind House LLC is the Customer. Lumenfield Works, Inc. is the Provider. This agreement is made up of the master terms, signed Order Forms, and the operating schedules summarized below. If an Order Form expressly names a master-term section that it changes, the Order Form controls only for that named service.', 48, cursor, 516, 8.8, ink, regularFont, 1.4) + 9;
  drawMetricCard(page, 48, cursor, 160, 'SERVICES', 'Analytics', 'Dashboards, pipelines, and support');
  drawMetricCard(page, 226, cursor, 160, 'REVIEW AREA', 'Section 8', 'Termination rights and conditions');
  drawMetricCard(page, 404, cursor, 160, 'DOCUMENT', '11 pages', 'Fourteen synthetic exit provisions');
  cursor += 81;
  drawPanel(page, 48, cursor, 516, 50, tealPale, line);
  drawLabel(page, 'REVIEW BRIEF', 61, cursor + 9, teal);
  drawParagraph(page, 'Identify who may terminate, the trigger and timing, any cure or transition duty, and terms that are unclear or conflict with another provision. Keep each finding tied to the source clause.', 61, cursor + 22, 490, 8.1, ink, regularFont, 1.28);
  cursor += 62;
  drawText(page, 'SECTION 8  /  TERMINATION', 48, cursor, 7.6, boldFont, teal);
  cursor = drawClause(page, '8.1', 'Termination for Convenience', 'Either party may terminate this Agreement by giving the other party forty-five (45) days\' written notice. Fees for services delivered through the effective date remain payable.', cursor + 14, { size: 8.8 });
  drawClause(page, '8.2', 'Customer Termination at Will', 'Customer may terminate this Agreement at any time, with or without cause, effective immediately upon written notice. Provider will be paid only for services completed before the notice.', cursor, { size: 8.8 });
}

// Page 2: service context and the breach cure path.
{
  const page = makePage(2, 'Sections 1-4 / operating foundation', 'Service scope and contract mechanics', 'The definitions and notice path used by the termination provisions');
  let cursor = drawSectionHeading(page, '01', 'Purpose and service boundary', 143);
  cursor = drawParagraph(page, 'Provider operates a hosted analytics workspace for Customer business teams. The subscribed services may include dashboard access, scheduled data ingestion, managed transformations, and support. Each Order Form identifies the active modules, connected source systems, service region, and monthly volume baseline.', 48, cursor, 516, 8.8) + 12;
  cursor = drawSectionHeading(page, '02', 'Defined terms', cursor);
  cursor = drawTable(page, cursor, [130, 386], ['TERM', 'AGREEMENT MEANING'], [
    ['Affected Service', 'The individual module or hosting region identified in an Order Form as impacted by the relevant event.'],
    ['Business Day', 'A day other than Saturday, Sunday, or a public holiday where the receiving party is located.'],
    ['Customer Data', 'Data submitted to or generated within the hosted workspace for Customer. Provider telemetry is excluded.'],
  ], { rowHeight: 30, fontSize: 7.8 }) + 11;
  cursor = drawSectionHeading(page, '03', 'Order Forms and service activation', cursor);
  cursor = drawParagraph(page, 'An Order Form names the subscribed modules, service region, transaction baseline, monthly fees, support tier, and start date. A new module or material change is active only after both parties sign the revised Order Form. Provider will not treat a forecast or project plan as a purchased service.', 48, cursor, 516, 8.2) + 10;
  cursor = drawSectionHeading(page, '04', 'Notices and cure periods', cursor);
  cursor = drawParagraph(page, 'Formal notices must be sent to the contract contacts in Schedule A by personal delivery, recognized courier, or email with delivery confirmation. A cure period starts on the first confirmed receipt. Operational tickets and automated alerts do not count as formal notice unless the receiving party acknowledges them as such.', 48, cursor, 516, 8.4) + 12;
  cursor = drawClause(page, '8.3', 'Termination for Material Breach', 'Either party may terminate this Agreement if the other party materially breaches it and does not cure the breach within thirty (30) days after receiving written notice that describes the breach.', cursor, { size: 8.7 });
  drawPanel(page, 48, cursor, 516, 44, goldPale, line);
  drawLabel(page, 'NOTICE RECORD', 61, cursor + 8, gold);
  drawParagraph(page, 'The notice log records delivery method, receipt time, the affected service, and the requested cure. If the breach is not reasonably curable within thirty days, the parties document a cure plan before the period expires.', 61, cursor + 20, 490, 7.8, ink, regularFont, 1.25);
}

// Page 3: measurable service levels and a reviewable SLA exit condition.
{
  const page = makePage(3, 'Section 5 / service levels', 'Availability, support, and service credits', 'Order Form targets inform the service-level termination right');
  let cursor = drawParagraph(page, 'Provider will operate the subscribed production workspace against the targets below. Measurement excludes agreed maintenance windows and outages caused by Customer-managed systems. Monthly reports show observed performance, incident tickets, and any service credits applied.', 48, 145, 516, 8.9) + 15;
  cursor = drawTable(page, cursor, [142, 116, 112, 146], ['MEASURE', 'TARGET', 'WINDOW', 'REMEDY'], [
    ['Workspace availability', '99.9%', 'Calendar month', '5% monthly fee credit per 0.1% below target'],
    ['Scheduled ingestion', 'Within 6 hours', '95% of runs', 'Priority incident and recovery plan'],
    ['Severity 1 response', '30 minutes', '24 x 7', 'Escalation to on-call service lead'],
    ['Planned maintenance', '12 hours', 'Per month', 'At least 5 Business Days notice'],
  ], { rowHeight: 35, fontSize: 7.4 }) + 13;
  cursor = drawSectionHeading(page, '05.4', 'Reporting and service credits', cursor);
  cursor = drawParagraph(page, 'Provider delivers a monthly service report within five Business Days after month end. Customer must request a credit within thirty days after the report is delivered. Credits apply to the affected Order Form only and do not replace a termination right expressly stated in Section 8.', 48, cursor, 516, 8.5) + 12;
  cursor = drawClause(page, '8.4', 'Service Level Misses', 'Customer may terminate this Agreement if Provider misses a service target in two consecutive months. The target appears in the applicable Order Form; this section does not state a cure period.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor + 1, 516, 48, pale, line);
  drawLabel(page, 'ORDER FORM REFERENCE', 61, cursor + 10, muted);
  drawParagraph(page, 'Availability is measured at the workspace endpoint. Data-source outages are excluded only when Provider identifies the source, affected interval, and mitigation in the monthly report.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 4: the deliberately unclear commercial standard and a separate transaction trigger.
{
  const page = makePage(4, 'Sections 6 and 8 / commercial changes', 'Commercial changes and exit rights', 'Review whether the trigger, notice, and affected-service scope are clear');
  let cursor = drawSectionHeading(page, '06.1', 'Commercial review', 143);
  cursor = drawParagraph(page, 'The parties meet quarterly to review delivery, forecast usage, material roadmap changes, and any operating dependency that could alter the subscribed service. A meeting summary identifies decisions, owners, and target dates. A summary does not amend this Agreement unless both parties sign an Order Form change.', 48, cursor, 516, 8.7) + 11;
  cursor = drawSectionHeading(page, '06.2', 'Material business events', cursor);
  cursor = drawParagraph(page, 'Each party will notify the other of a proposed sale, restructuring, or material change that could affect the subscribed services or the other party\'s access to them. Notices describe the expected effective date and any continuity measures then known.', 48, cursor, 516, 8.5) + 10;
  cursor = drawTable(page, cursor, [160, 178, 178], ['EVENT', 'INITIAL NOTICE', 'FOLLOW-UP'], [
    ['Proposed acquisition', 'As soon as the event is public', 'Identify service continuity contact'],
    ['Service model change', 'Before the next quarterly review', 'Update Order Form if needed'],
  ], { rowHeight: 30, fontSize: 7.7 }) + 12;
  cursor = drawClause(page, '8.5', 'Commercial Circumstances', 'Customer may terminate the affected Services for reasonable commercial circumstances. This section does not define the qualifying circumstances or provide a notice period.', cursor, { size: 8.9, fill: goldPale, accent: gold });
  cursor = drawClause(page, '8.6', 'Change of Control', 'Customer may terminate within sixty (60) days after Provider gives notice of a change of control to a direct competitor. The termination date must be stated in the notice.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 41, tealPale, line);
  drawLabel(page, 'RELATED TERM', 61, cursor + 8, teal);
  drawParagraph(page, 'The affected Order Form lists the services, hosting region, and contract contact for each subscribed module.', 61, cursor + 21, 490, 7.8, ink, regularFont, 1.22);
}

// Page 5: the security schedule and the containment trigger.
{
  const page = makePage(5, 'Section 7 / data safeguards', 'Data protection and security response', 'Customer Data handling duties apply throughout the service term');
  let cursor = drawParagraph(page, 'Provider will restrict access to Customer Data to trained personnel with a service need, encrypt data in transit and at rest, and maintain a tested incident-response process. Subprocessors must be bound by written safeguards at least as protective as this section.', 48, 145, 516, 8.8) + 12;
  cursor = drawSectionHeading(page, '07.1', 'Security controls', cursor);
  cursor = drawTable(page, cursor, [136, 190, 190], ['CONTROL', 'PROVIDER COMMITMENT', 'EVIDENCE'], [
    ['Access review', 'Review privileged access quarterly', 'Dated access-review record'],
    ['Encryption', 'TLS in transit; managed encryption at rest', 'Current control summary'],
    ['Subprocessors', 'Maintain a current processing list', 'Notice before material change'],
  ], { rowHeight: 29, fontSize: 7.4 }) + 10;
  cursor = drawSectionHeading(page, '07.2', 'Security incident handling', cursor);
  cursor = drawParagraph(page, 'A Security Incident is a confirmed unauthorized access to, disclosure of, or material loss of Customer Data. Provider will preserve relevant logs, identify affected systems, and coordinate containment with the Customer security contact. The incident clock starts when Provider confirms that Customer Data may be affected.', 48, cursor, 516, 8.3) + 10;
  cursor = drawClause(page, '8.7', 'Security Incident', 'Customer may terminate an affected Service if Provider has not begun containment within twenty-four (24) hours after notice of a confirmed unauthorized disclosure of Customer Data.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 53, pale, line);
  drawLabel(page, 'RESPONSE RECORD', 61, cursor + 9, muted);
  drawParagraph(page, 'The incident record includes the confirmation time, impacted service, containment owner, customer contact, and known exposure window. Updates continue until recovery actions are closed.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 6: commercial billing and the suspension / termination sequence.
{
  const page = makePage(6, 'Section 9 / fees and payment', 'Invoices, disputes, and service suspension', 'A payment sequence that distinguishes suspension from termination');
  let cursor = drawParagraph(page, 'Customer pays the recurring fees and approved usage charges in the applicable Order Form. Provider invoices monthly in arrears, identifies the service period and usage basis, and includes any credits approved under Section 5. Customer may dispute a line item in good faith without delaying payment of undisputed amounts.', 48, 145, 516, 8.8) + 12;
  cursor = drawSectionHeading(page, '09.1', 'Invoice and payment rules', cursor);
  cursor = drawTable(page, cursor, [152, 184, 180], ['STEP', 'REQUIREMENT', 'TIMING'], [
    ['Invoice delivery', 'Itemized fees and usage record', 'Within 5 Business Days after month end'],
    ['Payment', 'Undisputed invoice balance', 'Net 30 days from receipt'],
    ['Dispute notice', 'Identify amount and reason', 'Within 15 days after receipt'],
    ['Late interest', 'Lower of 1% per month or legal maximum', 'On overdue undisputed balance'],
  ], { rowHeight: 32, fontSize: 7.5 }) + 13;
  cursor = drawSectionHeading(page, '09.2', 'Dispute and service continuity', cursor);
  cursor = drawParagraph(page, 'The parties work in good faith to resolve invoice disputes within thirty days. Provider will not suspend an affected service while a timely, good-faith dispute remains unresolved, provided Customer continues to pay undisputed amounts.', 48, cursor, 516, 8.4) + 11;
  cursor = drawClause(page, '8.8', 'Nonpayment', 'Provider may suspend services for an undisputed invoice that remains unpaid ten (10) days after notice. Provider may terminate if payment is not received within thirty (30) days after the suspension.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 50, goldPale, line);
  drawLabel(page, 'PAYMENT RECORD', 61, cursor + 9, gold);
  drawParagraph(page, 'The suspension notice states the invoice number, undisputed balance, payment instructions, and the date on which access may be suspended.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 7: the separate reporting deadline, intentionally comparable with page 5.
{
  const page = makePage(7, 'Section 7 / incident reporting', 'Incident reports and recovery evidence', 'Containment and reporting are separate duties under this agreement');
  let cursor = drawSectionHeading(page, '07.3', 'Customer notification', 143);
  cursor = drawParagraph(page, 'Provider will notify the Customer security contact promptly after confirming a Security Incident. The initial notice states what is known, what remains under investigation, and when the next update will be delivered. Provider does not delay notice while it completes root-cause analysis.', 48, cursor, 516, 8.7) + 10;
  cursor = drawSectionHeading(page, '07.4', 'Written incident report', cursor);
  cursor = drawParagraph(page, 'The written report describes the incident timeline, systems and data affected, containment steps, recovery actions, and preventive changes. Provider identifies any facts that remain unverified and supplies an update after the investigation closes. The report is delivered to the contract security contact and may be supplemented as the investigation proceeds.', 48, cursor, 516, 8.5) + 11;
  drawPanel(page, 48, cursor, 516, 98, pale, line);
  drawLabel(page, 'INCIDENT RESPONSE SEQUENCE', 61, cursor + 10, teal);
  drawMetricCard(page, 61, cursor + 25, 145, 'CONFIRM', 'Incident', 'Scope the affected service');
  drawMetricCard(page, 223, cursor + 25, 145, 'CONTAIN', '24 hours', 'Begin containment after notice');
  drawMetricCard(page, 385, cursor + 25, 165, 'REPORT', '72 hours', 'Deliver written incident report');
  cursor += 112;
  cursor = drawClause(page, '8.9', 'Security Report Deadline', 'Customer may terminate the affected Service if Provider does not deliver a written incident report within seventy-two (72) hours after a confirmed unauthorized disclosure of Customer Data.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 49, tealPale, line);
  drawLabel(page, 'DELIVERY CHANNEL', 61, cursor + 9);
  drawParagraph(page, 'Incident reports are sent through the secure case workspace and copied to the security contact listed in Schedule A.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 8: support geography and a broad operational suitability condition.
{
  const page = makePage(8, 'Section 10 / service operation', 'Support coverage and operational scope', 'Service continuity commitments appear alongside a broad Provider exit right');
  let cursor = drawParagraph(page, 'Provider maintains the production workspace in the service region listed in the Order Form and supplies support through the channels below. Provider will give advance notice of planned changes that materially affect access, data location, or support hours.', 48, 145, 516, 8.8) + 11;
  cursor = drawSectionHeading(page, '10.1', 'Support coverage', cursor);
  cursor = drawTable(page, cursor, [128, 160, 228], ['SERVICE', 'COVERAGE', 'CUSTOMER EXPECTATION'], [
    ['Standard support', 'Business Days, 08:00-18:00 local', 'Response within 1 Business Day'],
    ['Severity 1 incident', '24 x 7 on-call', 'Phone bridge and 30-minute response'],
    ['Maintenance', 'Scheduled window', '5 Business Days advance notice'],
  ], { rowHeight: 31, fontSize: 7.5 }) + 12;
  cursor = drawSectionHeading(page, '10.2', 'Operating dependencies', cursor);
  cursor = drawParagraph(page, 'Customer maintains supported source connectors and current access credentials. Provider documents any dependency that prevents an agreed service level and proposes a recovery plan. A material change to hosting or support is reviewed under Section 6 and captured in the Order Form.', 48, cursor, 516, 8.4) + 11;
  cursor = drawClause(page, '8.10', 'Operational Suitability', 'Provider may terminate a Service when continued performance is not operationally suitable for Provider. No objective trigger or advance notice period is stated.', cursor, { size: 8.8, fill: goldPale, accent: gold });
  drawPanel(page, 48, cursor, 516, 48, pale, line);
  drawLabel(page, 'SERVICE EXIT CROSS-REFERENCE', 61, cursor + 9, muted);
  drawParagraph(page, 'Section 13 describes the data export and transition assistance available when a Service ends.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 9: assignment mechanics and the corporate notice path.
{
  const page = makePage(9, 'Section 11 / ownership changes', 'Assignment, successors, and notice contacts', 'Who may transfer the agreement and how the other party is informed');
  let cursor = drawSectionHeading(page, '11.1', 'Assignment by either party', 143);
  cursor = drawParagraph(page, 'Neither party may assign this Agreement without the other party\'s prior written consent, which will not be unreasonably withheld. A permitted successor assumes the assigning party\'s obligations. An assignment to an affiliate is allowed if the affiliate can perform the obligations and the assigning party remains responsible.', 48, cursor, 516, 8.7) + 11;
  cursor = drawTable(page, cursor, [168, 174, 174], ['CHANGE', 'NOTICE CONTENT', 'RECORD'], [
    ['Affiliate transfer', 'New entity and service owner', 'Updated contract contact'],
    ['Sale of business', 'Closing date and successor', 'Assumption document'],
    ['Change of control', 'Transaction summary and notice date', 'Customer receipt confirmation'],
  ], { rowHeight: 31, fontSize: 7.5 }) + 12;
  cursor = drawSectionHeading(page, '11.2', 'Continuity during transfer', cursor);
  cursor = drawParagraph(page, 'The parties cooperate to preserve access, support, and data handling during a permitted transfer. The successor receives only the information needed to perform the services and remains bound by the applicable confidentiality and security terms.', 48, cursor, 516, 8.5) + 12;
  cursor = drawClause(page, '8.11', 'Unauthorized Assignment', 'Either party may terminate if the other assigns this Agreement without written consent and does not reverse the assignment within thirty (30) days after notice.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 48, tealPale, line);
  drawLabel(page, 'FORMAL NOTICE CONTACTS', 61, cursor + 9);
  drawParagraph(page, 'Customer: contracts@northwind.example  |  Provider: legal@lumenfield.example. Synthetic addresses for demonstration only.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 10: volume definitions and the renegotiation trigger.
{
  const page = makePage(10, 'Section 12 / usage changes', 'Volume baseline and Order Form changes', 'Commercial thresholds are measured against the subscribed operating baseline');
  let cursor = drawParagraph(page, 'The parties set a monthly transaction baseline in each Order Form. Provider reports measured volume and forecast changes each month. A sustained change may require capacity planning, revised pricing, or a written service change before the new volume is treated as committed.', 48, 145, 516, 8.8) + 12;
  cursor = drawSectionHeading(page, '12.1', 'Illustrative Order Form baseline', cursor);
  cursor = drawTable(page, cursor, [150, 122, 122, 122], ['MEASURE', 'BASELINE', 'CURRENT MONTH', 'REVIEW'], [
    ['Transactions per month', '100,000', '104,500', 'Within baseline'],
    ['Peak daily volume', '8,000', '8,750', 'Capacity review'],
    ['Connected sources', '6', '6', 'No change'],
  ], { rowHeight: 32, fontSize: 7.4 }) + 12;
  cursor = drawSectionHeading(page, '12.2', 'Change proposal process', cursor);
  cursor = drawParagraph(page, 'A proposed change identifies the revised metric, service impact, fees, effective date, and any testing period. Neither party is bound to new pricing until both sign the revised Order Form. Existing service levels continue during the discussion unless the parties agree otherwise in writing.', 48, cursor, 516, 8.4) + 11;
  cursor = drawClause(page, '8.12', 'Requirement Change', 'Either party may terminate if Customer transaction volume changes by more than twenty percent for two consecutive months and the parties do not agree on a revised Order Form within ten (10) business days.', cursor, { size: 8.8 });
  drawPanel(page, 48, cursor, 516, 49, pale, line);
  drawLabel(page, 'MEASUREMENT NOTE', 61, cursor + 9, muted);
  drawParagraph(page, 'The percentage is calculated against the transaction baseline in the active Order Form, using complete calendar months.', 61, cursor + 23, 490, 7.8, ink, regularFont, 1.25);
}

// Page 11: transition promises beside broad regional discontinuation and end-of-term wording.
{
  const page = makePage(11, 'Section 13 / transition and expiry', 'Service transition and end of term', 'Data return, regional availability, and renewal timing');
  let cursor = drawSectionHeading(page, '13.1', 'Transition assistance', 143);
  cursor = drawParagraph(page, 'For ninety days after expiration or termination, Provider will make a reasonable transition contact available, maintain access needed for export, and answer questions about the service configuration. Assistance beyond the included period may be charged at the rates in the applicable Order Form.', 48, cursor, 516, 8.6) + 10;
  cursor = drawSectionHeading(page, '13.2', 'Data return and deletion', cursor);
  cursor = drawParagraph(page, 'Provider supplies a machine-readable export of Customer Data within thirty days after request. After the export window closes, Provider deletes remaining Customer Data within sixty days, except where retention is required by law. Provider confirms deletion in writing on request.', 48, cursor, 516, 8.4) + 12;
  cursor = drawClause(page, '8.13', 'Service Region Change', 'Provider may discontinue any service region or service at its discretion. Provider will notify Customer when practical; no minimum notice or transition period is specified.', cursor, { size: 8.7, fill: goldPale, accent: gold });
  cursor = drawClause(page, '8.14', 'End of Term', 'This Agreement ends on the expiration date if neither party gives written notice of renewal. Renewal requires written agreement by both parties.', cursor, { size: 8.7 });
  cursor = drawSectionHeading(page, '13.3', 'Renewal calendar', cursor + 2);
  drawTable(page, cursor, [156, 180, 180], ['MILESTONE', 'TARGET DATE', 'OWNER'], [
    ['Renewal review', '90 days before expiry', 'Business owners'],
    ['Written renewal notice', 'Before the current term ends', 'Both parties'],
  ], { rowHeight: 28, fontSize: 7.4 });
}

await mkdir(resolve('public/demos'), { recursive: true });
await writeFile(outputPath, Buffer.from(await pdf.save({ useObjectStreams: false })));
console.log(`Created ${outputPath} with 11 populated pages and 14 unlabeled termination clauses.`);
