import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { posix } from 'node:path';
import type { Annotation } from '../src/types';
import { annotationReviewStatus } from '../src/annotationStatus';

const packageRelationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const tagsContentType = 'application/vnd.openxmlformats-officedocument.presentationml.tags+xml';
const maxXmlPartLength = 25_000_000;
type XmlDocument = ReturnType<DOMParser['parseFromString']>;
type XmlElement = NonNullable<XmlDocument['documentElement']>;

interface PptxNamespaceProfile {
  presentation: string;
  drawing: string;
  relationships: string;
  slideRelationshipType: string;
  tagsRelationshipType: string;
}

const transitionalNamespaces: PptxNamespaceProfile = {
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  relationships: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  slideRelationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  tagsRelationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags',
};

const strictNamespaces: PptxNamespaceProfile = {
  presentation: 'http://purl.oclc.org/ooxml/presentationml/main',
  drawing: 'http://purl.oclc.org/ooxml/drawingml/main',
  relationships: 'http://purl.oclc.org/ooxml/officeDocument/relationships',
  slideRelationshipType: 'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
  tagsRelationshipType: 'http://purl.oclc.org/ooxml/officeDocument/relationships/tags',
};

export interface PptxAnnotationExportResult {
  buffer: Buffer;
  annotationsAdded: number;
  slidesModified: number;
  slidesTagged: number;
  tagValuesWritten: number;
  skipped: Array<{ annotationId: string; label: string; reason: 'slide_out_of_range' | 'slide_missing' | 'invalid_region' }>;
}

interface PptxSemanticTag {
  name: string;
  value: string;
}

function xmlSafe(value: string) {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff)) {
      output += character;
    }
  }
  return output;
}

function parseXml(xml: string, partName: string) {
  if (xml.length > maxXmlPartLength) throw new Error(`${partName} is larger than the PowerPoint exporter limit.`);
  let parseError = '';
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') parseError = message;
    },
  }).parseFromString(xml, 'application/xml');
  if (parseError || !document.documentElement) throw new Error(`PowerPoint file contains invalid ${partName} XML.`);
  return document;
}

function pptxNamespacesForPresentation(namespace: string | null | undefined) {
  if (namespace === transitionalNamespaces.presentation) return transitionalNamespaces;
  if (namespace === strictNamespaces.presentation) return strictNamespaces;
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function safeHexColor(value?: string, priority?: Annotation['reviewPriority']) {
  const trimmed = value?.trim().replace(/^#/, '').toUpperCase();
  if (trimmed && /^[0-9A-F]{6}$/.test(trimmed)) return trimmed;
  return priority === 'high' ? 'C64E57' : priority === 'low' ? '147F78' : 'C0842D';
}

function setDrawingTransform(shapeProperties: XmlElement, x: number, y: number, width: number, height: number, namespaces: PptxNamespaceProfile) {
  const transform = shapeProperties.ownerDocument!.createElementNS(namespaces.drawing, 'a:xfrm');
  const offset = shapeProperties.ownerDocument!.createElementNS(namespaces.drawing, 'a:off');
  offset.setAttribute('x', String(x));
  offset.setAttribute('y', String(y));
  const extent = shapeProperties.ownerDocument!.createElementNS(namespaces.drawing, 'a:ext');
  extent.setAttribute('cx', String(width));
  extent.setAttribute('cy', String(height));
  transform.appendChild(offset);
  transform.appendChild(extent);
  shapeProperties.appendChild(transform);
}

function addGeometry(shapeProperties: XmlElement, namespaces: PptxNamespaceProfile) {
  const document = shapeProperties.ownerDocument!;
  const geometry = document.createElementNS(namespaces.drawing, 'a:prstGeom');
  geometry.setAttribute('prst', 'rect');
  geometry.appendChild(document.createElementNS(namespaces.drawing, 'a:avLst'));
  shapeProperties.appendChild(geometry);
}

function addNonVisualProperties(document: XmlDocument, shape: XmlElement, id: number, name: string, description: string, textBox: boolean, namespaces: PptxNamespaceProfile) {
  const nonVisual = document.createElementNS(namespaces.presentation, 'p:nvSpPr');
  const cNvPr = document.createElementNS(namespaces.presentation, 'p:cNvPr');
  cNvPr.setAttribute('id', String(id));
  cNvPr.setAttribute('name', xmlSafe(name).slice(0, 120));
  cNvPr.setAttribute('descr', xmlSafe(description).slice(0, 1000));
  const cNvSpPr = document.createElementNS(namespaces.presentation, 'p:cNvSpPr');
  if (textBox) cNvSpPr.setAttribute('txBox', '1');
  const nvPr = document.createElementNS(namespaces.presentation, 'p:nvPr');
  nonVisual.appendChild(cNvPr);
  nonVisual.appendChild(cNvSpPr);
  nonVisual.appendChild(nvPr);
  shape.appendChild(nonVisual);
}

function annotationShapeDescription(annotation: Annotation, part: string, fragmentIndex?: number, fragmentCount?: number) {
  const target = `Slide ${annotation.pageNumber}; region ${annotation.x.toFixed(4)},${annotation.y.toFixed(4)},${annotation.width.toFixed(4)},${annotation.height.toFixed(4)}`;
  const fragment = fragmentIndex === undefined ? '' : `; fragment ${fragmentIndex + 1} of ${fragmentCount}`;
  return `[AnnotationStudio ID: ${annotation.id}] ${annotation.label}. ${part}${fragment}. ${target}. ${annotation.reason ?? annotation.note}. Evidence: ${annotation.excerpt ?? ''}`;
}

function appendOutline(document: XmlDocument, shapeTree: XmlElement, annotation: Annotation, id: number, fragmentIndex: number, fragmentCount: number, x: number, y: number, width: number, height: number, color: string, namespaces: PptxNamespaceProfile) {
  const shape = document.createElementNS(namespaces.presentation, 'p:sp');
  const safeId = xmlSafe(annotation.id).slice(0, 100);
  addNonVisualProperties(document, shape, id, `AS ${safeId} region ${fragmentIndex + 1}`, annotationShapeDescription(annotation, 'region', fragmentIndex, fragmentCount), false, namespaces);
  const properties = document.createElementNS(namespaces.presentation, 'p:spPr');
  setDrawingTransform(properties, x, y, width, height, namespaces);
  addGeometry(properties, namespaces);
  properties.appendChild(document.createElementNS(namespaces.drawing, 'a:noFill'));
  const line = document.createElementNS(namespaces.drawing, 'a:ln');
  line.setAttribute('w', '19050');
  const lineFill = document.createElementNS(namespaces.drawing, 'a:solidFill');
  const lineColor = document.createElementNS(namespaces.drawing, 'a:srgbClr');
  lineColor.setAttribute('val', color);
  lineFill.appendChild(lineColor);
  line.appendChild(lineFill);
  const dash = document.createElementNS(namespaces.drawing, 'a:prstDash');
  dash.setAttribute('val', 'solid');
  line.appendChild(dash);
  properties.appendChild(line);
  shape.appendChild(properties);
  const extensionList = Array.from(shapeTree.childNodes).find((node) => node.nodeType === node.ELEMENT_NODE && (node as XmlElement).namespaceURI === namespaces.presentation && (node as XmlElement).localName === 'extLst') ?? null;
  shapeTree.insertBefore(shape, extensionList);
}

function appendLabel(document: XmlDocument, shapeTree: XmlElement, annotation: Annotation, id: number, x: number, y: number, width: number, height: number, color: string, namespaces: PptxNamespaceProfile) {
  const shape = document.createElementNS(namespaces.presentation, 'p:sp');
  const safeId = xmlSafe(annotation.id).slice(0, 100);
  addNonVisualProperties(document, shape, id, `AS ${safeId} label`, annotationShapeDescription(annotation, 'label'), true, namespaces);
  const properties = document.createElementNS(namespaces.presentation, 'p:spPr');
  setDrawingTransform(properties, x, y, width, height, namespaces);
  addGeometry(properties, namespaces);
  const fill = document.createElementNS(namespaces.drawing, 'a:solidFill');
  const fillColor = document.createElementNS(namespaces.drawing, 'a:srgbClr');
  fillColor.setAttribute('val', color);
  fill.appendChild(fillColor);
  properties.appendChild(fill);
  const line = document.createElementNS(namespaces.drawing, 'a:ln');
  line.appendChild(document.createElementNS(namespaces.drawing, 'a:noFill'));
  properties.appendChild(line);
  shape.appendChild(properties);

  const textBody = document.createElementNS(namespaces.presentation, 'p:txBody');
  const bodyProperties = document.createElementNS(namespaces.drawing, 'a:bodyPr');
  bodyProperties.setAttribute('wrap', 'none');
  bodyProperties.setAttribute('lIns', '45720');
  bodyProperties.setAttribute('rIns', '45720');
  bodyProperties.setAttribute('tIns', '22860');
  bodyProperties.setAttribute('bIns', '22860');
  bodyProperties.setAttribute('anchor', 'ctr');
  textBody.appendChild(bodyProperties);
  textBody.appendChild(document.createElementNS(namespaces.drawing, 'a:lstStyle'));
  const paragraph = document.createElementNS(namespaces.drawing, 'a:p');
  const paragraphProperties = document.createElementNS(namespaces.drawing, 'a:pPr');
  paragraphProperties.setAttribute('algn', 'l');
  const defaultRunProperties = document.createElementNS(namespaces.drawing, 'a:defRPr');
  defaultRunProperties.setAttribute('sz', '900');
  defaultRunProperties.setAttribute('b', '1');
  const defaultFill = document.createElementNS(namespaces.drawing, 'a:solidFill');
  const defaultTextColor = document.createElementNS(namespaces.drawing, 'a:srgbClr');
  defaultTextColor.setAttribute('val', 'FFFFFF');
  defaultFill.appendChild(defaultTextColor);
  defaultRunProperties.appendChild(defaultFill);
  paragraphProperties.appendChild(defaultRunProperties);
  paragraph.appendChild(paragraphProperties);
  const run = document.createElementNS(namespaces.drawing, 'a:r');
  const runProperties = document.createElementNS(namespaces.drawing, 'a:rPr');
  runProperties.setAttribute('lang', 'ja-JP');
  runProperties.setAttribute('sz', '900');
  runProperties.setAttribute('b', '1');
  const runFill = document.createElementNS(namespaces.drawing, 'a:solidFill');
  const textColor = document.createElementNS(namespaces.drawing, 'a:srgbClr');
  textColor.setAttribute('val', 'FFFFFF');
  runFill.appendChild(textColor);
  runProperties.appendChild(runFill);
  const eastAsianFont = document.createElementNS(namespaces.drawing, 'a:ea');
  eastAsianFont.setAttribute('typeface', 'Yu Gothic');
  runProperties.appendChild(eastAsianFont);
  run.appendChild(runProperties);
  const text = document.createElementNS(namespaces.drawing, 'a:t');
  text.appendChild(document.createTextNode(xmlSafe(annotation.label).slice(0, 80)));
  run.appendChild(text);
  paragraph.appendChild(run);
  paragraph.appendChild(document.createElementNS(namespaces.drawing, 'a:endParaRPr'));
  textBody.appendChild(paragraph);
  shape.appendChild(textBody);

  const extensionList = Array.from(shapeTree.childNodes).find((node) => node.nodeType === node.ELEMENT_NODE && (node as XmlElement).namespaceURI === namespaces.presentation && (node as XmlElement).localName === 'extLst') ?? null;
  shapeTree.insertBefore(shape, extensionList);
}

function resolveSlidePart(target: string) {
  const normalized = target.replace(/^\/+/, '');
  const path = normalized.startsWith('ppt/') ? posix.normalize(normalized) : posix.normalize(posix.join('ppt', normalized));
  if (!path.startsWith('ppt/slides/') || path.includes('../')) throw new Error('Slide relationship points outside the presentation slide folder.');
  return path;
}

function resolveSlideRelatedPart(slidePath: string, target: string) {
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { /* Keep the package target and let the ZIP lookup report failure. */ }
  const normalizedTarget = decoded.replaceAll('\\', '/');
  if (!normalizedTarget || normalizedTarget.startsWith('/') || normalizedTarget.includes('?') || normalizedTarget.includes('#')) {
    throw Object.assign(new Error('Slide tag relationship target is invalid.'), { status: 415 });
  }
  const path = posix.normalize(posix.join(posix.dirname(slidePath), normalizedTarget));
  if (!path.startsWith('ppt/') || path === 'ppt' || path.includes('../')) {
    throw Object.assign(new Error('Slide tag relationship points outside the PowerPoint package.'), { status: 415 });
  }
  return path;
}

function annotationSemanticTags(items: Array<{ annotation: Annotation }>): PptxSemanticTag[] {
  const findings = items.map(({ annotation }) => ({
    id: xmlSafe(annotation.id).slice(0, 100),
    category: xmlSafe(annotation.label).slice(0, 60),
    target: {
      kind: 'slide',
      slide: annotation.pageNumber,
      boundingBox: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height },
      ...(annotation.fragments?.length ? { fragments: annotation.fragments.slice(0, 32) } : {}),
      ...(annotation.textAnchor ? { textAnchor: annotation.textAnchor } : {}),
    },
    evidence: xmlSafe(annotation.excerpt ?? '').slice(0, 1000),
    explanation: xmlSafe(annotation.reason || annotation.note).slice(0, 1000),
    reviewPriority: annotation.reviewPriority ?? (annotation.requiresReview ? 'high' : 'medium'),
    status: annotationReviewStatus(annotation),
    source: annotation.source,
  }));
  const priorities = findings.map((finding) => finding.reviewPriority);
  const highestReviewPriority = priorities.includes('high') ? 'high' : priorities.includes('medium') ? 'medium' : 'low';
  const categories = [...new Set(findings.map((finding) => finding.category))];
  return [
    { name: 'AnnotationStudio.SchemaVersion', value: '1' },
    { name: 'AnnotationStudio.AnnotationCount', value: String(findings.length) },
    { name: 'AnnotationStudio.Categories', value: JSON.stringify(categories) },
    { name: 'AnnotationStudio.HighestReviewPriority', value: highestReviewPriority },
    { name: 'AnnotationStudio.Findings', value: JSON.stringify(findings) },
  ];
}

function nextRelationshipId(root: XmlElement) {
  const used = new Set(Array.from(root.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship')).map((item) => item.getAttribute('Id')));
  let counter = 1;
  while (used.has(`rIdAnnotationStudioTags${counter}`)) counter += 1;
  return `rIdAnnotationStudioTags${counter}`;
}

async function updateSlideTags(zip: JSZip, slidePath: string, tags: PptxSemanticTag[], namespaces: PptxNamespaceProfile) {
  const slideDirectory = posix.dirname(slidePath);
  const slideFileName = posix.basename(slidePath);
  const relationshipsPath = posix.join(slideDirectory, '_rels', `${slideFileName}.rels`);
  const relationshipsFile = zip.file(relationshipsPath);
  const relationships = relationshipsFile
    ? parseXml(await relationshipsFile.async('string'), relationshipsPath)
    : parseXml(`<Relationships xmlns="${packageRelationshipsNamespace}"/>`, relationshipsPath);
  const relationshipsRoot = relationships.documentElement;
  if (!relationshipsRoot || relationshipsRoot.namespaceURI !== packageRelationshipsNamespace || relationshipsRoot.localName !== 'Relationships') {
    throw Object.assign(new Error('PowerPoint slide relationships are invalid.'), { status: 415 });
  }
  let tagRelationship = Array.from(relationshipsRoot.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
    .find((relationship) => relationship.getAttribute('Type') === namespaces.tagsRelationshipType);
  let tagsPath: string;
  if (tagRelationship) {
    if (tagRelationship.getAttribute('TargetMode') === 'External') {
      throw Object.assign(new Error('PowerPoint slide tags relationship must be internal.'), { status: 415 });
    }
    tagsPath = resolveSlideRelatedPart(slidePath, tagRelationship.getAttribute('Target') ?? '');
  } else {
    let counter = 1;
    do { tagsPath = `ppt/tags/annotation-studio-tags${counter++}.xml`; } while (zip.file(tagsPath));
    const target = posix.relative(slideDirectory, tagsPath);
    tagRelationship = relationships.createElementNS(packageRelationshipsNamespace, 'Relationship');
    tagRelationship.setAttribute('Id', nextRelationshipId(relationshipsRoot));
    tagRelationship.setAttribute('Type', namespaces.tagsRelationshipType);
    tagRelationship.setAttribute('Target', target);
    relationshipsRoot.appendChild(tagRelationship);
  }

  const existingTagsFile = zip.file(tagsPath);
  const tagsDocument = existingTagsFile
    ? parseXml(await existingTagsFile.async('string'), tagsPath)
    : parseXml(`<p:tagLst xmlns:p="${namespaces.presentation}"/>`, tagsPath);
  const tagsRoot = tagsDocument.documentElement;
  if (!tagsRoot || tagsRoot.namespaceURI !== namespaces.presentation || tagsRoot.localName !== 'tagLst') {
    throw Object.assign(new Error('PowerPoint user-defined tags part is invalid.'), { status: 415 });
  }
  const existingTags = Array.from(tagsRoot.getElementsByTagNameNS(namespaces.presentation, 'tag'));
  for (const tag of tags) {
    const matches = existingTags.filter((item) => item.getAttribute('name')?.toLowerCase() === tag.name.toLowerCase());
    const existing = matches[0];
    if (existing) {
      existing.setAttribute('val', tag.value);
      for (const duplicate of matches.slice(1)) tagsRoot.removeChild(duplicate);
    } else {
      const element = tagsDocument.createElementNS(namespaces.presentation, 'p:tag');
      element.setAttribute('name', tag.name);
      element.setAttribute('val', tag.value);
      tagsRoot.appendChild(element);
    }
  }

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!contentTypesFile) throw Object.assign(new Error('PowerPoint content types part is missing.'), { status: 415 });
  const contentTypes = parseXml(await contentTypesFile.async('string'), '[Content_Types].xml');
  const contentTypesRoot = contentTypes.documentElement;
  if (!contentTypesRoot || contentTypesRoot.namespaceURI !== contentTypesNamespace || contentTypesRoot.localName !== 'Types') {
    throw Object.assign(new Error('PowerPoint content types part is invalid.'), { status: 415 });
  }
  const partName = `/${tagsPath}`;
  const overrides = Array.from(contentTypesRoot.getElementsByTagNameNS(contentTypesNamespace, 'Override'));
  const existingOverride = overrides.find((override) => override.getAttribute('PartName') === partName);
  if (existingOverride && existingOverride.getAttribute('ContentType') !== tagsContentType) {
    throw Object.assign(new Error('PowerPoint slide tags part has an unexpected content type.'), { status: 415 });
  }
  if (!existingOverride) {
    const override = contentTypes.createElementNS(contentTypesNamespace, 'Override');
    override.setAttribute('PartName', partName);
    override.setAttribute('ContentType', tagsContentType);
    contentTypesRoot.appendChild(override);
  }

  const serializer = new XMLSerializer();
  zip.file(tagsPath, serializer.serializeToString(tagsDocument));
  zip.file(relationshipsPath, serializer.serializeToString(relationships));
  zip.file('[Content_Types].xml', serializer.serializeToString(contentTypes));
  return tags.length;
}

/** Adds editable outline and label shapes plus slide-level semantic tags to a new PPTX copy. */
export async function exportPowerPointAnnotations(source: Buffer, annotations: Annotation[]): Promise<PptxAnnotationExportResult> {
  if (annotations.length > 500) throw Object.assign(new Error('PowerPoint annotation export accepts at most 500 annotations.'), { status: 413 });
  const zip = await JSZip.loadAsync(source);
  const presentationFile = zip.file('ppt/presentation.xml');
  const relationshipsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationFile || !relationshipsFile) throw Object.assign(new Error('This file does not contain a valid PowerPoint presentation package.'), { status: 415 });
  const presentation = parseXml(await presentationFile.async('string'), 'ppt/presentation.xml');
  const relationships = parseXml(await relationshipsFile.async('string'), 'ppt/_rels/presentation.xml.rels');
  const presentationRoot = presentation.documentElement;
  const relationshipsRoot = relationships.documentElement;
  const namespaces = pptxNamespacesForPresentation(presentationRoot?.namespaceURI);
  if (!presentationRoot || !namespaces || presentationRoot.localName !== 'presentation'
    || !relationshipsRoot || relationshipsRoot.namespaceURI !== packageRelationshipsNamespace || relationshipsRoot.localName !== 'Relationships') {
    throw Object.assign(new Error('PowerPoint presentation structure is invalid.'), { status: 415 });
  }
  const slideSize = presentationRoot.getElementsByTagNameNS(namespaces.presentation, 'sldSz').item(0);
  const slideWidth = Number(slideSize?.getAttribute('cx'));
  const slideHeight = Number(slideSize?.getAttribute('cy'));
  if (!Number.isFinite(slideWidth) || slideWidth <= 0 || !Number.isFinite(slideHeight) || slideHeight <= 0) {
    throw Object.assign(new Error('PowerPoint slide dimensions could not be read.'), { status: 415 });
  }
  const relationshipMap = new Map(Array.from(relationshipsRoot.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship')).map((item) => [item.getAttribute('Id') ?? '', {
    target: item.getAttribute('Target') ?? '',
    type: item.getAttribute('Type') ?? '',
  }]));
  const slideIds = Array.from(presentationRoot.getElementsByTagNameNS(namespaces.presentation, 'sldId'));
  const slidePaths = slideIds.map((slideId) => {
    const relationshipId = slideId.getAttributeNS(namespaces.relationships, 'id');
    const relationship = relationshipId ? relationshipMap.get(relationshipId) : undefined;
    return relationship?.type === namespaces.slideRelationshipType ? relationship.target : undefined;
  }).map((target) => target ? resolveSlidePart(target) : null);
  const skipped: PptxAnnotationExportResult['skipped'] = [];
  const groups = new Map<string, Array<{ annotation: Annotation; x: number; y: number; width: number; height: number; outlineBoxes: Array<{ x: number; y: number; width: number; height: number }>; color: string }>>();
  for (const annotation of annotations) {
    const slidePath = slidePaths[annotation.pageNumber - 1];
    if (!slidePath) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: annotation.pageNumber >= 1 && annotation.pageNumber <= slidePaths.length ? 'slide_missing' : 'slide_out_of_range' });
      continue;
    }
    const x = clamp(annotation.x, 0, 0.98);
    const y = clamp(annotation.y, 0, 0.98);
    const width = Math.min(1 - x, clamp(annotation.width, 0.005, 1));
    const height = Math.min(1 - y, clamp(annotation.height, 0.005, 1));
    if (width <= 0 || height <= 0) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'invalid_region' });
      continue;
    }
    const sourceFragments = annotation.fragments?.length ? annotation.fragments.slice(0, 32) : [{ x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }];
    const fragmentsAreValid = sourceFragments.every((fragment) =>
      Number.isFinite(fragment.x) && Number.isFinite(fragment.y) && Number.isFinite(fragment.width) && Number.isFinite(fragment.height)
      && fragment.x >= 0 && fragment.y >= 0 && fragment.width > 0 && fragment.height > 0
      && fragment.x + fragment.width <= 1.001 && fragment.y + fragment.height <= 1.001);
    if (!fragmentsAreValid) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'invalid_region' });
      continue;
    }
    const outlineBoxes = sourceFragments.map((fragment) => {
      const fragmentX = clamp(fragment.x, 0, 0.98);
      const fragmentY = clamp(fragment.y, 0, 0.98);
      return {
        x: fragmentX,
        y: fragmentY,
        width: Math.min(1 - fragmentX, clamp(fragment.width, 0.005, 1)),
        height: Math.min(1 - fragmentY, clamp(fragment.height, 0.005, 1)),
      };
    });
    if (outlineBoxes.some((box) => box.width <= 0 || box.height <= 0)) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'invalid_region' });
      continue;
    }
    const items = groups.get(slidePath) ?? [];
    items.push({ annotation, x, y, width, height, outlineBoxes, color: safeHexColor(annotation.color, annotation.reviewPriority) });
    groups.set(slidePath, items);
  }

  let annotationsAdded = 0;
  let slidesModified = 0;
  let slidesTagged = 0;
  let tagValuesWritten = 0;
  for (const [slidePath, items] of groups) {
    const file = zip.file(slidePath);
    if (!file) {
      for (const item of items) skipped.push({ annotationId: item.annotation.id, label: item.annotation.label, reason: 'slide_missing' });
      continue;
    }
    const slide = parseXml(await file.async('string'), slidePath);
    const slideRoot = slide.documentElement;
    const shapeTree = slideRoot?.getElementsByTagNameNS(namespaces.presentation, 'spTree').item(0);
    if (!shapeTree) {
      for (const item of items) skipped.push({ annotationId: item.annotation.id, label: item.annotation.label, reason: 'slide_missing' });
      continue;
    }
    const maxShapeId = Array.from(shapeTree.getElementsByTagNameNS(namespaces.presentation, 'cNvPr'))
      .reduce((maximum, properties) => Math.max(maximum, Number(properties.getAttribute('id')) || 0), 0);
    let nextId = maxShapeId + 1;
    for (const item of items) {
      const left = Math.round(item.x * slideWidth);
      const top = Math.round(item.y * slideHeight);
      item.outlineBoxes.forEach((box, fragmentIndex) => {
        appendOutline(slide, shapeTree, item.annotation, nextId++, fragmentIndex, item.outlineBoxes.length, Math.round(box.x * slideWidth), Math.round(box.y * slideHeight), Math.max(1, Math.round(box.width * slideWidth)), Math.max(1, Math.round(box.height * slideHeight)), item.color, namespaces);
      });
      const tagHeight = Math.min(280_000, slideHeight);
      const tagTop = top >= tagHeight ? top - tagHeight : top;
      const tagWidth = Math.min(Math.max(1, slideWidth - left), Math.min(3_000_000, Math.max(500_000, item.annotation.label.length * 100_000)));
      appendLabel(slide, shapeTree, item.annotation, nextId++, left, tagTop, tagWidth, tagHeight, item.color, namespaces);
      annotationsAdded += 1;
    }
    zip.file(slidePath, new XMLSerializer().serializeToString(slide));
    tagValuesWritten += await updateSlideTags(zip, slidePath, annotationSemanticTags(items), namespaces);
    slidesTagged += 1;
    slidesModified += 1;
  }
  if (!annotationsAdded) return { buffer: source, annotationsAdded, slidesModified: 0, slidesTagged: 0, tagValuesWritten: 0, skipped };
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    annotationsAdded,
    slidesModified,
    slidesTagged,
    tagValuesWritten,
    skipped,
  };
}
