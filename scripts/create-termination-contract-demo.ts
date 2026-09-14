import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const pdf = await PDFDocument.create();
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const ink = rgb(0.13, 0.18, 0.22);
const muted = rgb(0.39, 0.46, 0.5);
const accent = rgb(0.09, 0.39, 0.4);
const line = rgb(0.84, 0.88, 0.89);
const pageWidth = 612;
const pageHeight = 792;

const fixedDate = new Date('2026-01-01T00:00:00.000Z');
pdf.setTitle('Fictional Services Agreement - Termination Review Demo');
pdf.setAuthor('Annotation Studio synthetic sample');
pdf.setSubject('Fictional termination clauses for an offline review demonstration');
pdf.setKeywords(['fictional', 'synthetic', 'termination', 'annotation demo']);
pdf.setCreator('Annotation Studio deterministic demo generator');
pdf.setProducer('Annotation Studio deterministic demo generator');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

function drawText(page: PDFPage, value: string, x: number, top: number, size = 11, font: PDFFont = regular, color = ink) {
  page.drawText(value, { x, y: pageHeight - top - size, size, font, color });
}

function drawRule(page: PDFPage, top: number, x1 = 48, x2 = 564) {
  page.drawLine({ start: { x: x1, y: pageHeight - top }, end: { x: x2, y: pageHeight - top }, thickness: 0.8, color: line });
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number) {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function drawParagraph(page: PDFPage, value: string, x: number, top: number, width: number, size = 11, color = ink) {
  const leading = size * 1.55;
  const lines = wrapText(value, regular, size, width);
  lines.forEach((lineText, index) => drawText(page, lineText, x, top + index * leading, size, regular, color));
  return top + lines.length * leading;
}

function drawHeader(page: PDFPage, pageNumber: number, section: string) {
  page.drawRectangle({ x: 0, y: pageHeight - 10, width: pageWidth, height: 10, color: accent });
  drawText(page, 'NORTHWIND HOUSE  /  SAMPLE AGREEMENT', 48, 29, 9, bold, accent);
  drawText(page, section, 48, 48, 9, bold, muted);
  drawText(page, 'Fictional Services Agreement', 48, 67, 22, bold);
  drawText(page, 'Termination provisions  ·  synthetic training sample  ·  not legal advice', 48, 100, 9.5, regular, muted);
  drawRule(page, 126);
  drawRule(page, 752);
  drawText(page, 'All names, terms, and circumstances in this sample are invented.', 48, 765, 8, regular, muted);
  drawText(page, `${pageNumber} / 2`, 530, 765, 8, regular, muted);
}

function drawClause(page: PDFPage, args: { number: string; title: string; top: number; body: string }) {
  const { number, title, top, body } = args;
  page.drawRectangle({ x: 48, y: pageHeight - top - 23, width: 56, height: 20, color: accent });
  drawText(page, number, 57, top + 4, 9, bold, rgb(1, 1, 1));
  drawText(page, title, 116, top + 1, 13, bold);
  const paragraphBottom = drawParagraph(page, body, 116, top + 29, 432, 10.5);
  drawRule(page, paragraphBottom + 12, 116, 564);
  return paragraphBottom + 28;
}

const first = pdf.addPage([pageWidth, pageHeight]);
drawHeader(first, 1, 'SECTION 8  /  TERMINATION');
drawText(first, 'AGREEMENT DETAILS', 48, 146, 9, bold, muted);
drawText(first, 'Between Lumenfield Works, Inc. and Northwind House LLC', 48, 164, 12, bold);
drawText(first, 'Effective date: January 1, 2026  ·  Term: one year, renewing annually', 48, 184, 10, regular, muted);
drawRule(first, 210);

drawClause(first, {
  number: '8.1', title: 'Termination for Convenience', top: 230,
  body: 'Either party may terminate this Agreement for convenience by giving the other party thirty (30) days written notice. Fees for services completed through the effective termination date remain payable.',
});
drawClause(first, {
  number: '8.2', title: 'Customer Termination at Will', top: 350,
  body: 'Customer may terminate this Agreement at any time, with or without cause, effective immediately upon written notice. Provider is not entitled to a termination fee or reimbursement for committed work not yet delivered.',
});
drawClause(first, {
  number: '8.3', title: 'Termination for Material Breach', top: 490,
  body: 'Either party may terminate this Agreement if the other party materially breaches it and does not cure that breach within twenty (20) days after receiving written notice that describes the breach.',
});

const second = pdf.addPage([pageWidth, pageHeight]);
drawHeader(second, 2, 'SECTION 8  /  TERMINATION (CONTINUED)');
drawClause(second, {
  number: '8.4', title: 'Insolvency Event', top: 177,
  body: 'Either party may terminate this Agreement by written notice if the other party becomes insolvent, makes a general assignment for the benefit of creditors, or enters a proceeding that is not dismissed within sixty (60) days.',
});
drawClause(second, {
  number: '8.5', title: 'Repeated Service Failure', top: 310,
  body: 'Customer may terminate this Agreement if Provider misses the monthly service target in three consecutive months. The target, measurement method, and notice period are not specified in this section.',
});
drawClause(second, {
  number: '8.6', title: 'Reasonable Business Circumstances', top: 455,
  body: 'Either party may terminate this Agreement for reasonable business circumstances. The parties will discuss a transition plan in good faith. This section does not define reasonable business circumstances or specify an advance notice period.',
});

const output = resolve('public/fictional-termination-contract.pdf');
await mkdir(resolve('public'), { recursive: true });
await writeFile(output, Buffer.from(await pdf.save({ useObjectStreams: false })));
console.log(`Created ${output}`);
