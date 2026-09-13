import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const pdf = await PDFDocument.create();
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const ink = rgb(0.12, 0.17, 0.22);
const muted = rgb(0.38, 0.44, 0.5);
const accent = rgb(0.08, 0.38, 0.43);
const line = rgb(0.83, 0.86, 0.88);

const text = (page: ReturnType<typeof pdf.addPage>, value: string, x: number, top: number, size = 11, font = regular, color = ink) => {
  page.drawText(value, { x, y: page.getHeight() - top - size, size, font, color });
};
const rule = (page: ReturnType<typeof pdf.addPage>, top: number, x1 = 48, x2 = 564) => {
  page.drawLine({ start: { x: x1, y: page.getHeight() - top }, end: { x: x2, y: page.getHeight() - top }, thickness: 0.8, color: line });
};
const header = (page: ReturnType<typeof pdf.addPage>, section: string, title: string, subtitle: string) => {
  page.drawRectangle({ x: 0, y: page.getHeight() - 10, width: page.getWidth(), height: 10, color: accent });
  text(page, 'FIELDNOTES  /  ENGINEERING', 48, 30, 9, bold, accent);
  text(page, section, 48, 48, 9, bold, muted);
  text(page, title, 48, 67, 23, bold);
  text(page, subtitle, 48, 101, 10, regular, muted);
  rule(page, 128);
};

const fanPhoto = await pdf.embedPng(await readFile(resolve('public/examples/cooling-fan-assembly.png')));
const explodedView = await pdf.embedPng(await readFile(resolve('public/examples/cooling-fan-exploded-view.png')));
const inspectionPhoto = await pdf.embedPng(await readFile(resolve('public/examples/maintenance-inspection-photo.png')));

// Page 1: operating limits and an image that can be selected as evidence.
const first = pdf.addPage([612, 792]);
header(first, 'PRODUCT REQUIREMENT SHEET', 'Axial cooling fan', 'Model CF-120  ·  Revision 04  ·  Sample document');
text(first, '01   Product overview', 48, 150, 13, bold);
first.drawImage(fanPhoto, { x: 48, y: 792 - 177 - 300, width: 300, height: 300 });
text(first, 'OPERATING TEMPERATURE', 372, 184, 9, bold, muted);
text(first, '-20 C to 120 C', 372, 201, 15, bold, accent);
rule(first, 231, 372, 564);
text(first, 'MAX FASTENING TORQUE', 372, 250, 9, bold, muted);
text(first, '12 N m', 372, 267, 15, bold, accent);
rule(first, 298, 372, 564);
text(first, 'RATED VOLTAGE', 372, 317, 9, bold, muted);
text(first, '24 V DC', 372, 334, 13, bold);
text(first, 'ACOUSTIC PRESSURE', 372, 369, 9, bold, muted);
text(first, '55 dBA maximum', 372, 386, 13, bold);
first.drawRectangle({ x: 48, y: 792 - 508 - 76, width: 516, height: 76, color: rgb(1, 0.96, 0.9) });
text(first, 'WARNING   Isolate the power supply before servicing.', 64, 526, 11, bold, rgb(0.62, 0.34, 0.04));
text(first, 'Wait until the rotor has stopped completely before opening the enclosure.', 64, 549, 10);
text(first, 'Use the specified torque; over-tightening can damage the mounting points.', 64, 567, 10);
text(first, 'Document owner: Product Engineering   ·   Fictional sample data', 48, 742, 9, regular, muted);

// Page 2: a generated exploded-view diagram for component-level annotation.
const second = pdf.addPage([612, 792]);
header(second, 'MAINTENANCE REFERENCE', 'Assembly overview', 'Identify parts for inspection and replacement');
text(second, '02   Exploded assembly', 48, 151, 13, bold);
second.drawImage(explodedView, { x: 58, y: 792 - 183 - 480, width: 480, height: 480 });
rule(second, 681);
text(second, 'Front grille  ·  Rotor and blades  ·  Motor  ·  Rear housing', 48, 701, 11, bold);
text(second, 'Select a component and attach an inspection note or replacement label.', 48, 725, 9, regular, muted);
text(second, 'Page 2  /  3', 523, 755, 8, regular, muted);

// Page 3: generated maintenance evidence photo, suitable for a safety annotation.
const third = pdf.addPage([612, 792]);
header(third, 'INSPECTION RECORD', 'Vibration check', 'Routine maintenance  ·  Sample evidence');
text(third, '03   Measurement in progress', 48, 151, 13, bold);
third.drawImage(inspectionPhoto, { x: 56, y: 792 - 179 - 375, width: 500, height: 375 });
third.drawRectangle({ x: 48, y: 792 - 611 - 69, width: 516, height: 69, color: rgb(0.94, 0.97, 0.97) });
text(third, 'CHECK   Power remains isolated during the vibration reading.', 64, 580, 11, bold, accent);
text(third, 'Record the measurement value and compare it with the previous service.', 64, 603, 10);
text(third, 'Document owner: Maintenance Team   ·   Fictional sample data', 48, 742, 9, regular, muted);

const bytes = await pdf.save();
const output = resolve('public/demo-specification.pdf');
await mkdir(resolve('public'), { recursive: true });
await writeFile(output, bytes);
console.log(`Created ${output}`);
