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
const STRICT_P = 'http://purl.oclc.org/ooxml/presentationml/main';
const STRICT_A = 'http://purl.oclc.org/ooxml/drawingml/main';
const STRICT_R = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const STRICT_TAGS_REL = `${STRICT_R}/tags`;
const STRICT_OFFICE_DOCUMENT_REL = 'http://purl.oclc.org/ooxml/relationships/officeDocument';

type NamespaceFlavor = 'transitional' | 'strict';

function profile(flavor: NamespaceFlavor) {
  return flavor === 'strict'
    ? { presentation: STRICT_P, drawing: STRICT_A, relationships: STRICT_R, tagsRelationship: STRICT_TAGS_REL, officeDocumentRelationship: STRICT_OFFICE_DOCUMENT_REL }
    : { presentation: P, drawing: A, relationships: R, tagsRelationship: TAGS_REL, officeDocumentRelationship: `${R}/officeDocument` };
}

function slideXml(name: string, flavor: NamespaceFlavor = 'transitional') {
  const namespaces = profile(flavor);
  return `<p:sld xmlns:p="${namespaces.presentation}" xmlns:a="${namespaces.drawing}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

async function makePptx(options: { existingTags?: boolean; flavor?: NamespaceFlavor } = {}) {
  const flavor = options.flavor ?? 'transitional';
  const namespaces = profile(flavor);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide9.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>${options.existingTags ? `<Override PartName="/ppt/tags/custom.xml" ContentType="${TAGS_TYPE}"/>` : ''}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${namespaces.officeDocumentRelationship}" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${namespaces.presentation}" xmlns:r="${namespaces.relationships}"><p:sldIdLst><p:sldId id="256" r:id="rIdFirst"/><p:sldId id="257" r:id="rIdSecond"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rIdFirst" Type="${namespaces.relationships}/slide" Target="slides/slide2.xml"/><Relationship Id="rIdSecond" Type="${namespaces.relationships}/slide" Target="slides/slide9.xml"/></Relationships>`);
  zip.file('ppt/slides/slide2.xml', slideXml('Existing slide two', flavor));
  zip.file('ppt/slides/slide9.xml', slideXml('Existing slide nine', flavor));
  zip.file('ppt/slides/_rels/slide2.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rIdCustom" Type="urn:annotation-studio:test-custom" Target="../custom/metadata.xml"/>${options.existingTags ? `<Relationship Id="rIdExistingTags" Type="${namespaces.tagsRelationship}" Target="../tags/custom.xml"/>` : ''}</Relationships>`);
  zip.file('ppt/custom/metadata.xml', '<metadata>keep this unrelated OOXML part</metadata>');
  if (options.existingTags) {
    zip.file('ppt/tags/custom.xml', `<p:tagLst xmlns:p="${namespaces.presentation}"><p:tag name="Owner" val="Legal"/><p:tag name="AnnotationStudio.Categories" val="stale"/></p:tagLst>`);
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

test('exports canonical text fragments as linked PowerPoint shapes and keeps target geometry in slide tags', async () => {
  const source = await makePptx();
  const report = {
    sourceFormat: 'PPTX', pageCount: 2,
    pages: [1, 2].map((number) => ({ number, widthPoints: 720, heightPoints: 540, warningCount: 0, warnings: [], svg: '<svg/>' })),
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('deck.pptx', report, 'doc-1', source);
  const fragments = [
    { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
    { x: 0.1, y: 0.28, width: 0.25, height: 0.05 },
  ];
  const textAnchor = {
    quote: { exact: 'first line second line', prefix: '', suffix: '' },
    position: { start: 0, end: 22, unit: 'normalized-page-text' as const },
  };
  adapter.annotate({
    id: 'multi-line-finding', documentId: 'doc-1',
    target: { kind: 'slide', slide: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.13 }, fragments, textAnchor },
    label: 'SAFETY', evidence: textAnchor.quote.exact, explanation: 'Two-line safety instruction.', reviewPriority: 'high', status: 'approved', excerpt: textAnchor.quote.exact,
  });

  const result = await adapter.export({ format: 'native-annotated' });
  assert.equal(result.annotationsExported, 1);
  const output = await JSZip.loadAsync(result.buffer);
  const slide = new DOMParser().parseFromString(await output.file('ppt/slides/slide2.xml')!.async('string'), 'application/xml');
  const properties = Array.from(slide.getElementsByTagNameNS(P, 'cNvPr'));
  assert.equal(properties.some((item) => item.getAttribute('name') === 'AS multi-line-finding region 1'), true);
  assert.equal(properties.some((item) => item.getAttribute('name') === 'AS multi-line-finding region 2'), true);
  assert.equal(properties.some((item) => item.getAttribute('name') === 'AS multi-line-finding label'), true);
  assert.equal(properties.filter((item) => item.getAttribute('descr')?.includes('[AnnotationStudio ID: multi-line-finding]')).length, 3);
  const tagRel = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  const tagsTarget = Array.from(tagRel.getElementsByTagNameNS(PKG, 'Relationship')).find((item) => item.getAttribute('Type') === TAGS_REL)?.getAttribute('Target');
  const tagsPath = `ppt/tags/${tagsTarget?.split('/').at(-1)}`;
  const tagsDoc = new DOMParser().parseFromString(await output.file(tagsPath)!.async('string'), 'application/xml');
  const tags = new Map(Array.from(tagsDoc.getElementsByTagNameNS(P, 'tag')).map((item) => [item.getAttribute('name'), item.getAttribute('val')]));
  const findings = JSON.parse(tags.get('AnnotationStudio.Findings') ?? '[]') as Array<{ id: string; target: { slide: number; fragments: unknown[]; textAnchor: { quote: { exact: string } } } }>;
  assert.equal(findings[0]?.id, 'multi-line-finding');
  assert.equal(findings[0]?.target.slide, 1);
  assert.equal(findings[0]?.target.fragments.length, 2);
  assert.equal(findings[0]?.target.textAnchor.quote.exact, 'first line second line');
});

test('keeps full distinct valid IDs in shape names when IDs share a long prefix', async () => {
  const source = await makePptx();
  const sharedPrefix = 'annotation-id-'.padEnd(72, 'x');
  const ids = [`${sharedPrefix}A`, `${sharedPrefix}B`];
  const result = await exportPowerPointAnnotations(source, ids.map((id, index) => ({
    id, pageNumber: 1, x: 0.1 + index * 0.4, y: 0.2, width: 0.3, height: 0.2,
    label: `Finding ${index + 1}`, note: '', reason: 'A unique stable finding link.', excerpt: 'Source evidence.',
    reviewPriority: 'low' as const, color: '#178b87', source: 'ai' as const,
  })));
  assert.equal(result.annotationsAdded, 2);
  const output = await JSZip.loadAsync(result.buffer);
  const slide = new DOMParser().parseFromString(await output.file('ppt/slides/slide2.xml')!.async('string'), 'application/xml');
  const names = Array.from(slide.getElementsByTagNameNS(P, 'cNvPr')).map((item) => item.getAttribute('name'));
  for (const id of ids) {
    assert.ok(names.includes(`AS ${id} region 1`), `outline shape should retain the full ID ${id}`);
    assert.ok(names.includes(`AS ${id} label`), `label shape should retain the full ID ${id}`);
  }
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
  assert.equal(await output.file('ppt/custom/metadata.xml')!.async('string'), '<metadata>keep this unrelated OOXML part</metadata>');

  const tagRelationships = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  const tagRelationship = Array.from(tagRelationships.getElementsByTagNameNS(PKG, 'Relationship')).find((item) => item.getAttribute('Type') === TAGS_REL);
  assert.equal(tagRelationship?.getAttribute('Target'), '../tags/annotation-studio-tags1.xml');
  assert.equal(Array.from(tagRelationships.getElementsByTagNameNS(PKG, 'Relationship')).some((item) => item.getAttribute('Id') === 'rIdCustom' && item.getAttribute('Type') === 'urn:annotation-studio:test-custom' && item.getAttribute('Target') === '../custom/metadata.xml'), true);
  const tagPart = new DOMParser().parseFromString(await output.file('ppt/tags/annotation-studio-tags1.xml')!.async('string'), 'application/xml');
  const values = new Map(Array.from(tagPart.getElementsByTagNameNS(P, 'tag')).map((tag) => [tag.getAttribute('name'), tag.getAttribute('val')]));
  assert.equal(values.get('AnnotationStudio.AnnotationCount'), '1');
  assert.deepEqual(JSON.parse(values.get('AnnotationStudio.Categories') ?? '[]'), ['HIGH RISK']);
  assert.equal(values.get('AnnotationStudio.HighestReviewPriority'), 'high');
  const findings = JSON.parse(values.get('AnnotationStudio.Findings') ?? '[]');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    id: 'slide-region', category: 'HIGH RISK',
    target: { kind: 'slide', slide: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 } },
    evidence: 'Either party may terminate.', explanation: 'Either party can terminate without cause.', reviewPriority: 'high', status: 'approved', source: 'ai',
  });
  const contentTypes = new DOMParser().parseFromString(await output.file('[Content_Types].xml')!.async('string'), 'application/xml');
  assert.equal(Array.from(contentTypes.getElementsByTagNameNS(TYPES, 'Override')).some((item) => item.getAttribute('PartName') === '/ppt/tags/annotation-studio-tags1.xml' && item.getAttribute('ContentType') === TAGS_TYPE), true);
});

test('writes Strict OOXML shapes and semantic tags with Strict namespaces and unchanged OPC content types', async () => {
  const source = await makePptx({ flavor: 'strict' });
  const sourceCopy = Buffer.from(source);
  const result = await exportPowerPointAnnotations(source, [{
    id: 'strict-slide-region', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'STRICT REVIEW', note: 'Review the claim.', reason: 'The evidence is not linked to a source.',
    excerpt: 'A strong claim.', reviewPriority: 'high', color: '#C64E57', source: 'ai', reviewedByHuman: true,
  }]);
  assert.equal(result.annotationsAdded, 1);
  assert.equal(result.slidesTagged, 1);
  assert.deepEqual(source, sourceCopy, 'Strict export preserves the uploaded source bytes');

  const output = await JSZip.loadAsync(result.buffer);
  const slide = new DOMParser().parseFromString(await output.file('ppt/slides/slide2.xml')!.async('string'), 'application/xml');
  assert.equal(slide.documentElement?.namespaceURI, STRICT_P);
  assert.equal(slide.getElementsByTagNameNS(STRICT_P, 'sp').length, 3);
  assert.equal(slide.getElementsByTagNameNS(STRICT_A, 'off').item(1)?.getAttribute('x'), '914400');
  assert.equal(slide.documentElement?.textContent?.includes('STRICT REVIEW'), true);

  const relationships = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  assert.equal(relationships.documentElement?.namespaceURI, PKG, 'relationship part stays in the OPC namespace');
  const tagsRelationship = Array.from(relationships.getElementsByTagNameNS(PKG, 'Relationship')).find((item) => item.getAttribute('Type') === STRICT_TAGS_REL);
  assert.equal(tagsRelationship?.getAttribute('Target'), '../tags/annotation-studio-tags1.xml');
  assert.equal(Array.from(relationships.getElementsByTagNameNS(PKG, 'Relationship')).some((item) => item.getAttribute('Type') === TAGS_REL), false);

  const tags = new DOMParser().parseFromString(await output.file('ppt/tags/annotation-studio-tags1.xml')!.async('string'), 'application/xml');
  assert.equal(tags.documentElement?.namespaceURI, STRICT_P);
  assert.equal(tags.getElementsByTagNameNS(STRICT_P, 'tag').length, 5);
  const contentTypes = new DOMParser().parseFromString(await output.file('[Content_Types].xml')!.async('string'), 'application/xml');
  assert.equal(contentTypes.documentElement?.namespaceURI, TYPES, '[Content_Types].xml stays in the OPC content-types namespace');
  assert.equal(Array.from(contentTypes.getElementsByTagNameNS(TYPES, 'Override')).some((item) => item.getAttribute('PartName') === '/ppt/tags/annotation-studio-tags1.xml' && item.getAttribute('ContentType') === TAGS_TYPE), true);
});

test('updates existing Strict user-defined tags without converting them to Transitional XML', async () => {
  const source = await makePptx({ existingTags: true, flavor: 'strict' });
  const result = await exportPowerPointAnnotations(source, [{
    id: 'strict-existing-tags', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'Product', note: 'Product summary.', reason: 'The slide describes the product.',
    excerpt: 'product workflow', reviewPriority: 'medium', color: '#178b87', source: 'ai',
  }]);
  assert.equal(result.slidesTagged, 1);
  const output = await JSZip.loadAsync(result.buffer);
  assert.equal(output.file('ppt/tags/annotation-studio-tags1.xml'), null);
  const tags = new DOMParser().parseFromString(await output.file('ppt/tags/custom.xml')!.async('string'), 'application/xml');
  assert.equal(tags.documentElement?.namespaceURI, STRICT_P);
  const entries = Array.from(tags.getElementsByTagNameNS(STRICT_P, 'tag'));
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'Owner')?.getAttribute('val'), 'Legal');
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Categories')?.getAttribute('val'), '["Product"]');
  const relationships = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  assert.equal(Array.from(relationships.getElementsByTagNameNS(PKG, 'Relationship')).filter((item) => item.getAttribute('Type') === STRICT_TAGS_REL).length, 1);
});

test('rejects unrecognized PresentationML namespaces instead of writing mixed-flavor output', async () => {
  const sourceZip = await JSZip.loadAsync(await makePptx());
  const presentation = await sourceZip.file('ppt/presentation.xml')!.async('string');
  sourceZip.file('ppt/presentation.xml', presentation.replace(P, 'urn:unsupported:presentationml'));
  const source = Buffer.from(await sourceZip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(() => exportPowerPointAnnotations(source, [{
    id: 'unsupported-presentation', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25,
    label: 'Unsupported', note: '', reason: 'Unknown presentation namespaces must fail closed.', color: '#178b87', source: 'ai',
  }]), /PowerPoint presentation structure is invalid/);
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
  assert.equal(await output.file('ppt/custom/metadata.xml')!.async('string'), '<metadata>keep this unrelated OOXML part</metadata>');
  const relations = new DOMParser().parseFromString(await output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'), 'application/xml');
  assert.equal(Array.from(relations.getElementsByTagNameNS(PKG, 'Relationship')).some((item) => item.getAttribute('Id') === 'rIdCustom' && item.getAttribute('Type') === 'urn:annotation-studio:test-custom' && item.getAttribute('Target') === '../custom/metadata.xml'), true);
  const tags = new DOMParser().parseFromString(await output.file('ppt/tags/custom.xml')!.async('string'), 'application/xml');
  const entries = Array.from(tags.getElementsByTagNameNS(P, 'tag'));
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'Owner')?.getAttribute('val'), 'Legal');
  assert.equal(entries.find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Categories')?.getAttribute('val'), '["Product"]');
  assert.equal(entries.filter((tag) => tag.getAttribute('name') === 'AnnotationStudio.Categories').length, 1);
  const findings = JSON.parse(entries.find((tag) => tag.getAttribute('name') === 'AnnotationStudio.Findings')?.getAttribute('val') ?? '[]');
  assert.equal(findings[0]?.status, 'auto');
  assert.deepEqual(source, sourceCopy, 'the exported copy does not mutate uploaded bytes');
});

test('matches owned tag names using locale-independent ASCII case folding', async () => {
  const sourceZip = await JSZip.loadAsync(await makePptx({ existingTags: true }));
  sourceZip.file('ppt/tags/custom.xml', `<p:tagLst xmlns:p="${P}"><p:tag name="Owner" val="Legal"/><p:tag name="ANNOTATIONSTUDIO.FINDINGS" val="stale"/></p:tagLst>`);
  const source = Buffer.from(await sourceZip.generateAsync({ type: 'nodebuffer' }));
  const originalLocaleLower = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function toTurkishLocaleLowerCase() { return originalLocaleLower.call(this, 'tr'); };
  try {
    const result = await exportPowerPointAnnotations(source, [{
      id: 'turkish-case', pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.2,
      label: 'Risk', note: '', reason: 'Check the exact value.', excerpt: 'Source text.',
      reviewPriority: 'medium', color: '#178b87', source: 'ai', reviewedByHuman: true,
    }]);
    const exported = await JSZip.loadAsync(result.buffer);
    const tagPart = new DOMParser().parseFromString(await exported.file('ppt/tags/custom.xml')!.async('string'), 'application/xml');
    const ownedFindings = Array.from(tagPart.getElementsByTagNameNS(P, 'tag')).filter((tag) => tag.getAttribute('name')?.toLowerCase() === 'annotationstudio.findings');
    assert.equal(ownedFindings.length, 1, 'an uppercase existing ASCII key is updated instead of duplicated');
    assert.deepEqual(JSON.parse(ownedFindings[0]?.getAttribute('val') ?? '[]').map((finding: { id: string }) => finding.id), ['turkish-case']);
  } finally {
    String.prototype.toLocaleLowerCase = originalLocaleLower;
  }
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
