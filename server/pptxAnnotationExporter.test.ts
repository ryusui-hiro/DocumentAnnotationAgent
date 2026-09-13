import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type { PreviewReport } from 'document-svg';
import { PagedDocumentAdapter } from './documentAdapter';
import { exportPowerPointAnnotations } from './pptxAnnotationExporter';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const TAGS_REL = `${R}/tags`;
const TAGS_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.tags+xml';

function slideXml(name: string) {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

async function makePptx(options: { existingTags?: boolean } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide9.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>${options.existingTags ? `<Override PartName="/ppt/tags/custom.xml" ContentType="${TAGS_TYPE}"/>` : ''}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rIdFirst"/><p:sldId id="257" r:id="rIdSecond"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rIdFirst" Type="${R}/slide" Target="slides/slide2.xml"/><Relationship Id="rIdSecond" Type="${R}/slide" Target="slides/slide9.xml"/></Relationships>`);
  zip.file('ppt/slides/slide2.xml', slideXml('Existing slide two'));
  zip.file('ppt/slides/slide9.xml', slideXml('Existing slide nine'));
  if (options.existingTags) {
    zip.file('ppt/slides/_rels/slide2.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rIdExistingTags" Type="${TAGS_REL}" Target="../tags/custom.xml"/></Relationships>`);
    zip.file('ppt/tags/custom.xml', `<p:tagLst xmlns:p="${P}"><p:tag name="Owner" val="Legal"/><p:tag name="AnnotationStudio.Categories" val="stale"/></p:tagLst>`);
  }
  zip.file('ppt/media/keep.txt', 'untouched media part');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

test('the shared DocumentAdapter exports canonical slide records as editable shapes and semantic tags', async () => {
  const source = await makePptx();
  const original = Buffer.from(source);
  const report = {
    sourceFormat: 'PPTX', pageCount: 2,
    pages: [1, 2].map((number) => ({ number, widthPoints: 720, heightPoints: 540, warningCount: 0, warnings: [], svg: '<svg/>' })),
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('deck.pptx', report, 'doc-1', source);
  adapter.annotate({
    id: 'adapter-slide-1', documentId: 'doc-1',
    target: { kind: 'slide', slide: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 } },
    label: 'Product', evidence: 'Existing slide two', explanation: 'The slide introduces the product.',
    reviewPriority: 'medium', status: 'approved', note: 'Product overview.', reason: 'The slide contains the product workflow.', excerpt: 'Existing slide two',
    source: 'ai', color: '#178b87', reviewedByHuman: true,
  });

  const exported = await adapter.export({ format: 'native-annotated' });
  assert.equal(exported.fileName, 'deck-annotated.pptx');
  assert.equal(exported.annotationsExported, 1);
  assert.equal(exported.metadata?.slidesTagged, 1);
  assert.equal(exported.metadata?.tagValuesWritten, 5);
  assert.deepEqual(source, original);
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.ok(zip.file('ppt/tags/annotation-studio-tags1.xml'));
  assert.equal((await zip.file('ppt/slides/slide2.xml')!.async('string')).includes('Product'), true);
});

test('writes editable annotation shapes to the correct slide relationship without changing the source', async () => {
  const source = await makePptx();
  const sourceCopy = Buffer.from(source);
  const result = await exportPowerPointAnnotations(source, [{
    id: 'slide-region', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'HIGH RISK', note: 'One-sided termination.', reason: 'Either party can terminate without cause.',
    excerpt: 'Either party may terminate.', reviewPriority: 'high', color: '#C64E57', source: 'ai', reviewedByHuman: true,
  }]);
  assert.equal(result.annotationsAdded, 1);
  assert.equal(result.slidesModified, 1);
  assert.equal(result.slidesTagged, 1);
  assert.equal(result.tagValuesWritten, 5);
  assert.deepEqual(source, sourceCopy);

  const output = await JSZip.loadAsync(result.buffer);
  const slideOne = new DOMParser().parseFromString(await output.file('ppt/slides/slide2.xml')!.async('string'), 'application/xml');
  const slideTwo = new DOMParser().parseFromString(await output.file('ppt/slides/slide9.xml')!.async('string'), 'application/xml');
  const shapes = Array.from(slideOne.getElementsByTagNameNS(P, 'sp'));
  assert.equal(shapes.length, 3);
  assert.equal(slideTwo.getElementsByTagNameNS(P, 'sp').length, 1);
  assert.equal(slideOne.documentElement?.textContent?.includes('HIGH RISK'), true);
  assert.equal(slideOne.documentElement?.textContent?.includes('Existing slide two'), true);
  const shapeIds = Array.from(slideOne.getElementsByTagNameNS(P, 'cNvPr')).map((element) => element.getAttribute('id'));
  assert.deepEqual(shapeIds, ['1', '2', '3', '4']);
  const offset = slideOne.getElementsByTagNameNS(A, 'off').item(1);
  const extent = slideOne.getElementsByTagNameNS(A, 'ext').item(1);
  assert.equal(offset?.getAttribute('x'), '914400');
  assert.equal(offset?.getAttribute('y'), '1371600');
  assert.equal(extent?.getAttribute('cx'), '2743200');
  assert.equal(extent?.getAttribute('cy'), '1714500');
  assert.equal(await output.file('ppt/media/keep.txt')!.async('string'), 'untouched media part');

  const tagRelationships = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  const tagRelationship = Array.from(tagRelationships.getElementsByTagNameNS(PKG, 'Relationship')).find((item) => item.getAttribute('Type') === TAGS_REL);
  assert.equal(tagRelationship?.getAttribute('Target'), '../tags/annotation-studio-tags1.xml');
  const tagPart = new DOMParser().parseFromString(await output.file('ppt/tags/annotation-studio-tags1.xml')!.async('string'), 'application/xml');
  const values = new Map(Array.from(tagPart.getElementsByTagNameNS(P, 'tag')).map((tag) => [tag.getAttribute('name'), tag.getAttribute('val')]));
  assert.equal(values.get('AnnotationStudio.AnnotationCount'), '1');
  assert.deepEqual(JSON.parse(values.get('AnnotationStudio.Categories') ?? '[]'), ['HIGH RISK']);
  assert.equal(values.get('AnnotationStudio.HighestReviewPriority'), 'high');
  const findings = JSON.parse(values.get('AnnotationStudio.Findings') ?? '[]');
  assert.deepEqual(findings, [{ id: 'slide-region', category: 'HIGH RISK', evidence: 'Either party may terminate.', explanation: 'Either party can terminate without cause.', reviewPriority: 'high', status: 'corrected', source: 'ai' }]);
  const contentTypes = new DOMParser().parseFromString(await output.file('[Content_Types].xml')!.async('string'), 'application/xml');
  assert.equal(Array.from(contentTypes.getElementsByTagNameNS(TYPES, 'Override')).some((item) => item.getAttribute('PartName') === '/ppt/tags/annotation-studio-tags1.xml' && item.getAttribute('ContentType') === TAGS_TYPE), true);
});

test('preserves user-defined slide tags and replaces only its own semantic values', async () => {
  const source = await makePptx({ existingTags: true });
  const sourceCopy = Buffer.from(source);
  const result = await exportPowerPointAnnotations(source, [{
    id: 'slide-category', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'Product', note: 'The slide introduces the service.', reason: 'The slide describes the product workflow.',
    excerpt: 'service workflow', reviewPriority: 'medium', color: '#178b87', source: 'ai',
  }]);
  assert.equal(result.slidesTagged, 1);
  const output = await JSZip.loadAsync(result.buffer);
  assert.ok(output.file('ppt/tags/custom.xml'));
  assert.equal(output.file('ppt/tags/annotation-studio-tags1.xml'), null);
  const tags = new DOMParser().parseFromString(await output.file('ppt/tags/custom.xml')!.async('string'), 'application/xml');
  const entries = Array.from(tags.getElementsByTagNameNS(P, 'tag'));
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'Owner')?.getAttribute('val'), 'Legal');
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Categories')?.getAttribute('val'), '["Product"]');
  assert.equal(entries.filter((tag) => tag.getAttribute('name') === 'AnnotationStudio.Categories').length, 1);
  const findings = JSON.parse(entries.find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Findings')?.getAttribute('val') ?? '[]');
  assert.equal(findings[0]?.status, 'auto');
  assert.deepEqual(source, sourceCopy, 'the exported copy does not mutate uploaded bytes');
});

test('removes XML-invalid control characters from shape text and slide tags', async () => {
  const source = await makePptx();
  const result = await exportPowerPointAnnotations(source, [{
    id: 'control-id', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'Pro\u0001duct', note: 'Visible note.', reason: 'The claim is unsupported.\u0002',
    excerpt: 'Claim\u0003', reviewPriority: 'high', color: '#C64E57', source: 'ai',
  }]);
  const output = await JSZip.loadAsync(result.buffer);
  const tags = new DOMParser().parseFromString(await output.file('ppt/tags/annotation-studio-tags1.xml')!.async('string'), 'application/xml');
  const findings = JSON.parse(Array.from(tags.getElementsByTagNameNS(P, 'tag')).find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Findings')?.getAttribute('val') ?? '[]');
  assert.equal(findings[0].category, 'Product');
  assert.equal(findings[0].explanation, 'The claim is unsupported.');
  assert.equal(findings[0].evidence, 'Claim');
});

test('reports annotations that point outside the slide list and leaves the source unchanged', async () => {
  const source = await makePptx();
  const result = await exportPowerPointAnnotations(source, [{
    id: 'out-of-range', pageNumber: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.2,
    label: 'Unsupported', note: '', reason: 'There is no third slide.', color: '#178b87', source: 'ai',
  }]);
  assert.equal(result.annotationsAdded, 0);
  assert.equal(result.slidesTagged, 0);
  assert.equal(result.skipped[0]?.reason, 'slide_out_of_range');
  assert.equal(result.buffer, source);
});
