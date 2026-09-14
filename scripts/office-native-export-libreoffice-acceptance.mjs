import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { PDFDocument } from 'pdf-lib';
import { createDocxFixture, createPptxFixture } from './office-fixtures.mjs';
import { PagedDocumentAdapter } from '../server/documentAdapter.ts';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const presentationNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const relationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const libreOffice = process.env.LIBREOFFICE_BIN || 'soffice';

function syntheticReport(sourceFormat, sourceBuffer) {
  const widthPoints = sourceFormat === 'pptx' ? 720 : 612;
  const heightPoints = sourceFormat === 'pptx' ? 540 : 792;
  return {
    converter: 'synthetic acceptance fixture', version: '1', source: 'in-memory fixture', sourceFormat,
    elapsedMs: 0, inputBytes: sourceBuffer.byteLength, pageCount: 1, largestPageIrBytes: 0,
    pages: [{
      number: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', widthPoints, heightPoints,
      nodeCount: 0, warningCount: 0, warnings: [], estimatedIrBytes: 0,
    }],
    warnings: [], needsReview: false,
  };
}

function runLibreOffice(args) {
  const result = spawnSync(libreOffice, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.error) throw new Error(`Could not run ${libreOffice}: ${result.error.message}`);
  assert.equal(result.status, 0, `LibreOffice exited with ${result.status ?? result.signal}. `
    + `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function parseXml(xml, partName) {
  let parseError = '';
  const document = new DOMParser({ onError: (level, message) => {
    if (level === 'error' || level === 'fatalError') parseError = message;
  } }).parseFromString(xml, 'application/xml');
  assert.ok(document.documentElement && !parseError, `${partName} is malformed: ${parseError}`);
  return document;
}

async function readPart(zip, path) {
  const part = zip.file(path);
  assert.ok(part, `Office package is missing ${path}`);
  return part.async('string');
}

async function convert(inputPath, extension, outputDirectory, profileDirectory) {
  await Promise.all([mkdir(outputDirectory), mkdir(profileDirectory)]);
  const profileUrl = pathToFileURL(profileDirectory).href;
  const result = runLibreOffice([
    '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
    `-env:UserInstallation=${profileUrl}`, '--convert-to', extension, '--outdir', outputDirectory, inputPath,
  ]);
  const outputPath = join(outputDirectory, `annotated.${extension}`);
  const bytes = await readFile(outputPath);
  assert.ok(bytes.byteLength > 0, `LibreOffice produced an empty ${extension} file`);
  return { bytes, outputPath, log: result.stdout };
}

async function convertToPdf(inputPath, outputDirectory, profileDirectory) {
  const result = await convert(inputPath, 'pdf', outputDirectory, profileDirectory);
  assert.equal(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-', 'LibreOffice output is not a PDF');
  const pdf = await PDFDocument.load(result.bytes);
  assert.equal(pdf.getPageCount(), 1, 'Synthetic Office fixture should remain one page/slide after conversion');
  return result;
}

const tempDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-libreoffice-acceptance-'));
try {
  const version = runLibreOffice(['--version']).stdout;
  assert.match(version, /LibreOffice/i, `Unexpected executable version: ${version}`);

  const sourceDocx = await createDocxFixture();
  const docxDocumentId = 'lo-acceptance-docx-document';
  const docxAdapter = new PagedDocumentAdapter('synthetic.docx', syntheticReport('docx', sourceDocx), docxDocumentId, sourceDocx);
  const docxAnnotation = {
    id: 'lo-acceptance-docx-1', documentId: docxDocumentId,
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.1 } },
    label: 'HIGH RISK', evidence: 'Either party may terminate without cause.',
    explanation: 'The clause permits termination without cause.',
    reason: 'The clause permits termination without cause.',
    excerpt: 'Either party may terminate without cause.', note: 'Please review the termination clause.',
    reviewPriority: 'high', status: 'approved',
  };
  const docxExport = await docxAdapter.export({ format: 'native-annotated', annotations: [docxAnnotation] });
  assert.equal(docxExport.annotationsExported, 1, 'Synthetic DOCX annotation did not anchor');
  assert.equal(docxExport.metadata?.commentsAdded, 1, 'Synthetic DOCX comment was not created');

  const sourcePptx = await createPptxFixture();
  const pptxDocumentId = 'lo-acceptance-pptx-document';
  const pptxAdapter = new PagedDocumentAdapter('synthetic.pptx', syntheticReport('pptx', sourcePptx), pptxDocumentId, sourcePptx);
  const pptxAnnotation = {
    id: 'lo-acceptance-pptx-1', documentId: pptxDocumentId,
    target: { kind: 'slide', slide: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.25 } },
    label: 'PRODUCT', evidence: 'Confidential product roadmap',
    explanation: 'Contains future plans.', reason: 'Contains future plans.',
    excerpt: 'Confidential product roadmap', note: 'Roadmap disclosure',
    reviewPriority: 'medium', status: 'approved', color: '#178b87', source: 'ai',
    requiresReview: false, reviewedByHuman: true,
  };
  const pptxExport = await pptxAdapter.export({ format: 'native-annotated', annotations: [pptxAnnotation] });
  assert.equal(pptxExport.annotationsExported, 1, 'Synthetic PPTX annotation was not exported');
  assert.equal(pptxExport.metadata?.slidesTagged, 1, 'Synthetic PPTX slide was not tagged');
  const pptxExportZip = await JSZip.loadAsync(pptxExport.buffer);
  const originalTagParts = Object.keys(pptxExportZip.files).filter((path) => /^ppt\/tags\/annotation-studio-tags\d+\.xml$/i.test(path));
  assert.equal(originalTagParts.length, 1, 'Local PPTX exporter did not create exactly one annotation tag part');
  const originalSlideRelationships = parseXml(await readPart(pptxExportZip, 'ppt/slides/_rels/slide1.xml.rels'), 'exported slide relationships');
  const originalTagRelationship = Array.from(originalSlideRelationships.getElementsByTagNameNS(relationshipsNamespace, 'Relationship'))
    .find((relationship) => relationship.getAttribute('Type')?.endsWith('/tags'));
  assert.ok(originalTagRelationship, 'Local PPTX exporter did not link the annotation tag part');
  const originalTagsXml = await readPart(pptxExportZip, originalTagParts[0]);
  assert.match(originalTagsXml, /AnnotationStudio\.Findings/);
  assert.match(originalTagsXml, /PRODUCT/);
  assert.match(originalTagsXml, /Confidential product roadmap/);

  const docxSourcePath = join(tempDirectory, 'docx-source', 'annotated.docx');
  const pptxSourcePath = join(tempDirectory, 'pptx-source', 'annotated.pptx');
  await Promise.all([mkdir(join(tempDirectory, 'docx-source')), mkdir(join(tempDirectory, 'pptx-source'))]);
  await Promise.all([writeFile(docxSourcePath, docxExport.buffer), writeFile(pptxSourcePath, pptxExport.buffer)]);

  const docxRoundTrip = await convert(docxSourcePath, 'docx', join(tempDirectory, 'docx-roundtrip'), join(tempDirectory, 'profile-docx'));
  const docxZip = await JSZip.loadAsync(docxRoundTrip.bytes);
  const docxXml = parseXml(await readPart(docxZip, 'word/document.xml'), 'round-tripped word/document.xml');
  const commentXml = parseXml(await readPart(docxZip, 'word/comments.xml'), 'round-tripped word/comments.xml');
  assert.ok(docxXml.getElementsByTagNameNS(wordNamespace, 'commentRangeStart').length > 0, 'DOCX comment range start did not survive LibreOffice');
  assert.ok(docxXml.getElementsByTagNameNS(wordNamespace, 'commentRangeEnd').length > 0, 'DOCX comment range end did not survive LibreOffice');
  assert.ok(docxXml.getElementsByTagNameNS(wordNamespace, 'commentReference').length > 0, 'DOCX comment reference did not survive LibreOffice');
  const docxText = docxXml.documentElement.textContent ?? '';
  const commentText = commentXml.documentElement.textContent ?? '';
  assert.match(docxText, /Either party may terminate without cause\./, 'Original DOCX excerpt was lost');
  assert.match(commentText, /HIGH RISK/);
  assert.match(commentText, /The clause permits termination without cause\./);
  assert.match(commentText, /Either party may terminate without cause\./);
  const wordRelationships = parseXml(await readPart(docxZip, 'word/_rels/document.xml.rels'), 'round-tripped Word relationships');
  assert.ok(Array.from(wordRelationships.getElementsByTagNameNS(relationshipsNamespace, 'Relationship'))
    .some((relationship) => relationship.getAttribute('Type')?.endsWith('/comments')), 'DOCX comments relationship did not survive LibreOffice');

  const pptxRoundTrip = await convert(pptxSourcePath, 'pptx', join(tempDirectory, 'pptx-roundtrip'), join(tempDirectory, 'profile-pptx'));
  const pptxZip = await JSZip.loadAsync(pptxRoundTrip.bytes);
  const slideXml = parseXml(await readPart(pptxZip, 'ppt/slides/slide1.xml'), 'round-tripped ppt/slides/slide1.xml');
  const slideText = slideXml.documentElement.textContent ?? '';
  const shapes = Array.from(slideXml.getElementsByTagNameNS(presentationNamespace, 'sp'));
  assert.match(slideText, /Confidential product roadmap/, 'Original PPTX text was lost');
  assert.ok(shapes.some((shape) => shape.getElementsByTagNameNS(presentationNamespace, 'cNvPr').item(0)?.getAttribute('name')?.startsWith('AS lo-acceptance-pptx-1 region ')), 'PPTX outline shape with its stable finding ID did not survive LibreOffice');
  assert.ok(shapes.some((shape) => shape.getElementsByTagNameNS(presentationNamespace, 'cNvPr').item(0)?.getAttribute('name') === 'AS lo-acceptance-pptx-1 label'), 'PPTX label shape with its stable finding ID did not survive LibreOffice');
  assert.match(slideText, /PRODUCT/, 'PPTX annotation label text did not survive LibreOffice');

  const tagParts = Object.keys(pptxZip.files).filter((path) => /^ppt\/tags\/annotation-studio-tags\d+\.xml$/i.test(path));
  const slideRelationships = parseXml(await readPart(pptxZip, 'ppt/slides/_rels/slide1.xml.rels'), 'round-tripped slide relationships');
  const tagRelationship = Array.from(slideRelationships.getElementsByTagNameNS(relationshipsNamespace, 'Relationship'))
    .find((relationship) => relationship.getAttribute('Type')?.endsWith('/tags'));
  let semanticTagsSurvived = false;
  if (tagRelationship && tagParts.length) {
    const path = posix.normalize(posix.join('ppt/slides', tagRelationship.getAttribute('Target') ?? ''));
    const tagsXml = await readPart(pptxZip, path);
    semanticTagsSurvived = /AnnotationStudio\.Findings/.test(tagsXml) && /PRODUCT/.test(tagsXml) && /Confidential product roadmap/.test(tagsXml);
  }

  const docxPdf = await convertToPdf(docxRoundTrip.outputPath, join(tempDirectory, 'docx-pdf'), join(tempDirectory, 'profile-docx-pdf'));
  const pptxPdf = await convertToPdf(pptxRoundTrip.outputPath, join(tempDirectory, 'pptx-pdf'), join(tempDirectory, 'profile-pptx-pdf'));

  console.log(JSON.stringify({
    libreOffice: version,
    fixtures: 'synthetic DOCX and PPTX generated in memory; no user documents or external providers used',
    docx: {
      output: 'LibreOffice same-format round-trip succeeded; ZIP/XML package reopened successfully',
      annotationsAnchored: docxExport.annotationsExported,
      commentRangeAndReferenceSurvived: true,
      commentTextSurvived: true,
      pdfConversion: 'passed',
      roundTripLog: docxRoundTrip.log,
      pdfLog: docxPdf.log,
    },
    pptx: {
      output: 'LibreOffice same-format round-trip succeeded; ZIP/XML package reopened successfully',
      annotationShapesSurvived: shapes.filter((shape) => (shape.getElementsByTagNameNS(presentationNamespace, 'cNvPr').item(0)?.getAttribute('name') ?? '').startsWith('AS lo-acceptance-pptx-1 ')).length,
      annotationLabelTextSurvived: true,
      semanticTagsBeforeLibreOffice: true,
      semanticTagsSurvived,
      tagPartsAfterRoundTrip: tagParts,
      slideTagRelationshipSurvived: Boolean(tagRelationship),
      pdfConversion: 'passed',
      roundTripLog: pptxRoundTrip.log,
      pdfLog: pptxPdf.log,
    },
    note: semanticTagsSurvived
      ? 'PPTX semantic tags survived this LibreOffice round-trip.'
      : 'LibreOffice opened and rewrote the PPTX but dropped the custom semantic tag part and/or relationship; tags are present in the original project export before LibreOffice round-trip.',
    temporaryArtifacts: 'removed after the check',
  }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
