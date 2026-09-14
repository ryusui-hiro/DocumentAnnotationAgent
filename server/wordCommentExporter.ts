import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { posix } from 'node:path';
import type { Annotation, TextAnchor } from '../src/types';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRelationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const commentsRelationshipType = `${officeRelationshipNamespace}/comments`;
const commentsContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const maxXmlPartLength = 25_000_000;
type XmlDocument = ReturnType<DOMParser['parseFromString']>;
type XmlElement = NonNullable<XmlDocument['documentElement']>;
type XmlNode = NonNullable<XmlElement['firstChild']>;

export interface WordCommentExportAnnotation extends Pick<Annotation, 'id' | 'label' | 'note' | 'reason' | 'excerpt' | 'reviewPriority'> {
  textAnchor?: TextAnchor;
}

export interface WordCommentExportResult {
  buffer: Buffer;
  commentsAdded: number;
  annotationsAnchored: number;
  skipped: Array<{ annotationId: string; label: string; reason: 'missing_excerpt' | 'not_found' | 'ambiguous' | 'unsupported_structure' }>;
}

function parseXml(xml: string, partName: string) {
  if (xml.length > maxXmlPartLength) throw new Error(`${partName} is larger than the Word exporter limit.`);
  let parseError = '';
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') parseError = message;
    },
  }).parseFromString(xml, 'application/xml');
  if (parseError || !document.documentElement) throw new Error(`Word document contains invalid ${partName} XML.`);
  return document;
}

function normalizedText(value: string) {
  return value.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

interface WordCharacterPosition {
  startNode: XmlNode;
  startOffset: number;
  startRun: XmlElement;
  endNode: XmlNode;
  endOffset: number;
  endRun: XmlElement;
}

interface ParagraphTextIndex {
  text: string;
  positions: WordCharacterPosition[];
}

function nearestRun(node: XmlNode, paragraph: XmlElement) {
  for (let parent = node.parentNode; parent && parent !== paragraph; parent = parent.parentNode) {
    if (parent.nodeType === parent.ELEMENT_NODE) {
      const element = parent as XmlElement;
      if (element.namespaceURI === wordNamespace && element.localName === 'r') return element;
      if (element.namespaceURI === wordNamespace && element.localName === 'p') return null;
    }
  }
  return null;
}

function paragraphTextIndex(paragraph: XmlElement): ParagraphTextIndex {
  let text = '';
  const positions: WordCharacterPosition[] = [];
  const textElements = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'));
  for (const textElement of textElements) {
    const run = nearestRun(textElement as unknown as XmlNode, paragraph);
    if (!run) continue;
    for (let node = textElement.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== node.TEXT_NODE) continue;
      const value = node.nodeValue ?? '';
      for (let offset = 0; offset < value.length;) {
        const codePoint = value.codePointAt(offset);
        if (codePoint === undefined) break;
        const character = String.fromCodePoint(codePoint);
        const length = character.length;
        const source: WordCharacterPosition = {
          startNode: node as unknown as XmlNode,
          startOffset: offset,
          startRun: run,
          endNode: node as unknown as XmlNode,
          endOffset: offset + length,
          endRun: run,
        };
        if (/\s/.test(character)) {
          if (text.endsWith(' ')) {
            positions[positions.length - 1] = { ...positions[positions.length - 1]!, endNode: source.endNode, endOffset: source.endOffset, endRun: source.endRun };
          } else {
            text += ' ';
            positions.push(source);
          }
        } else {
          const lowered = character.toLocaleLowerCase();
          text += lowered;
          for (let index = 0; index < lowered.length; index += 1) positions.push(source);
        }
        offset += length;
      }
    }
  }
  return { text, positions };
}

function getParagraphs(document: XmlDocument): XmlElement[] {
  return Array.from(document.getElementsByTagNameNS(wordNamespace, 'p'));
}

interface MatchedWordExcerpt {
  start: WordCharacterPosition;
  end: WordCharacterPosition;
}

interface ParagraphCommentGroup {
  annotations: WordCommentExportAnnotation[];
  match: MatchedWordExcerpt;
  query: string;
  startIndex: number;
  endIndex: number;
}

function runOffsetForPosition(run: XmlElement, textNode: XmlNode, offset: number) {
  const textElement = textNode.parentNode;
  let total = 0;
  for (let child = run.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== child.ELEMENT_NODE) continue;
    const element = child as XmlElement;
    if (element.namespaceURI === wordNamespace && element.localName === 'rPr') continue;
    if (child === textElement) {
      for (let text = child.firstChild; text; text = text.nextSibling) {
        if (text === textNode) return total + offset;
        if (text.nodeType === text.TEXT_NODE) total += (text.nodeValue ?? '').length;
      }
      return total + offset;
    }
    if (element.namespaceURI === wordNamespace && element.localName === 't') total += (element.textContent ?? '').length;
  }
  return total + offset;
}

function cloneWordText(document: XmlDocument, source: XmlElement, value: string) {
  if (!value) return null;
  const clone = source.cloneNode(false) as XmlElement;
  clone.appendChild(document.createTextNode(value));
  if (/^\s|\s$/.test(value)) clone.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  return clone;
}

function splitRunAtOffset(run: XmlElement, rawOffset: number) {
  const runLength = Array.from(run.childNodes)
    .filter((child) => child.nodeType === child.ELEMENT_NODE && (child as XmlElement).namespaceURI === wordNamespace && (child as XmlElement).localName === 't')
    .reduce((sum, child) => sum + ((child as XmlElement).textContent ?? '').length, 0);
  const offset = Math.min(runLength, Math.max(0, Math.floor(rawOffset)));
  if (offset === 0) return { before: null, after: run };
  if (offset >= runLength) return { before: run, after: null };

  const document = run.ownerDocument as XmlDocument;
  const before = run.cloneNode(false) as XmlElement;
  const after = run.cloneNode(false) as XmlElement;
  let cursor = 0;
  for (let child = run.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === child.ELEMENT_NODE) {
      const element = child as XmlElement;
      if (element.namespaceURI === wordNamespace && element.localName === 'rPr') {
        before.appendChild(child.cloneNode(true));
        after.appendChild(child.cloneNode(true));
        continue;
      }
      if (element.namespaceURI === wordNamespace && element.localName === 't') {
        const value = element.textContent ?? '';
        const end = cursor + value.length;
        if (offset <= cursor) after.appendChild(child.cloneNode(true));
        else if (offset >= end) before.appendChild(child.cloneNode(true));
        else {
          before.appendChild(cloneWordText(document, element, value.slice(0, offset - cursor))!);
          after.appendChild(cloneWordText(document, element, value.slice(offset - cursor))!);
        }
        cursor = end;
        continue;
      }
      if (cursor < offset) before.appendChild(child.cloneNode(true));
      else after.appendChild(child.cloneNode(true));
    } else if (child.nodeType === child.TEXT_NODE) {
      if (cursor < offset) before.appendChild(child.cloneNode(true));
      else after.appendChild(child.cloneNode(true));
    }
  }
  const hasContent = (fragment: XmlElement) => Array.from(fragment.childNodes).some((child) => !(child.nodeType === child.ELEMENT_NODE && (child as XmlElement).namespaceURI === wordNamespace && (child as XmlElement).localName === 'rPr'));
  const hasBefore = hasContent(before);
  const hasAfter = hasContent(after);
  const parent = run.parentNode as XmlNode | null;
  if (!parent) return { before: run, after: null };
  if (hasBefore) parent.insertBefore(before, run);
  if (hasAfter) parent.insertBefore(after, run);
  parent.removeChild(run);
  return { before: hasBefore ? before : null, after: hasAfter ? after : null };
}

function directParagraphChild(paragraph: XmlElement, node: XmlNode) {
  let child: XmlNode = node;
  while (child.parentNode && child.parentNode !== paragraph) child = child.parentNode as XmlNode;
  return child;
}

function appendCommentReference(document: XmlDocument, paragraph: XmlElement, after: XmlNode, id: number) {
  const rangeEnd = document.createElementNS(wordNamespace, 'w:commentRangeEnd');
  setWordAttribute(rangeEnd, 'id', String(id));
  paragraph.insertBefore(rangeEnd, after.nextSibling);
  const referenceRun = document.createElementNS(wordNamespace, 'w:r');
  const reference = document.createElementNS(wordNamespace, 'w:commentReference');
  setWordAttribute(reference, 'id', String(id));
  referenceRun.appendChild(reference);
  paragraph.insertBefore(referenceRun, rangeEnd.nextSibling);
}

function insertExactCommentRange(document: XmlDocument, paragraph: XmlElement, match: MatchedWordExcerpt, id: number) {
  let startChild: XmlNode;
  let endChild: XmlNode;
  const startOffset = runOffsetForPosition(match.start.startRun, match.start.startNode, match.start.startOffset);
  const endOffset = runOffsetForPosition(match.end.endRun, match.end.endNode, match.end.endOffset);
  if (match.start.startRun === match.end.endRun) {
    const endSplit = splitRunAtOffset(match.end.endRun, endOffset);
    const prefix = endSplit.before ?? match.end.endRun;
    const startSplit = splitRunAtOffset(prefix, startOffset);
    const selected = startSplit.after ?? prefix;
    startChild = directParagraphChild(paragraph, selected);
    endChild = startChild;
  } else {
    const endSplit = splitRunAtOffset(match.end.endRun, endOffset);
    const startSplit = splitRunAtOffset(match.start.startRun, startOffset);
    startChild = directParagraphChild(paragraph, startSplit.after ?? match.start.startRun);
    endChild = directParagraphChild(paragraph, endSplit.before ?? match.end.endRun);
  }
  const start = document.createElementNS(wordNamespace, 'w:commentRangeStart');
  setWordAttribute(start, 'id', String(id));
  paragraph.insertBefore(start, startChild);
  appendCommentReference(document, paragraph, endChild, id);
}

function isSimpleTextRun(run: XmlElement) {
  let hasText = false;
  for (let child = run.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === child.TEXT_NODE && !(child.nodeValue ?? '').trim()) continue;
    if (child.nodeType !== child.ELEMENT_NODE) return false;
    const element = child as XmlElement;
    if (element.namespaceURI !== wordNamespace) return false;
    if (element.localName === 'rPr') continue;
    if (element.localName !== 't') return false;
    hasText = true;
  }
  return hasText;
}

function isWhitespaceTextNode(node: XmlNode) {
  return node.nodeType === 3 && !(node.nodeValue ?? '').trim();
}

function isElementNode(node: XmlNode) {
  return node.nodeType === 1;
}

function canInsertExactCommentRange(paragraph: XmlElement, match: MatchedWordExcerpt) {
  const startRun = match.start.startRun;
  const endRun = match.end.endRun;
  if (startRun.parentNode !== paragraph || endRun.parentNode !== paragraph) return false;
  if (!isSimpleTextRun(startRun) || !isSimpleTextRun(endRun)) return false;
  const startOffset = runOffsetForPosition(startRun, match.start.startNode, match.start.startOffset);
  const endOffset = runOffsetForPosition(endRun, match.end.endNode, match.end.endOffset);
  if (startRun === endRun && startOffset >= endOffset) return false;

  let betweenEndRuns = startRun === endRun;
  for (let child: XmlNode | null = startRun as unknown as XmlNode; child; child = child.nextSibling as XmlNode | null) {
    if (isWhitespaceTextNode(child)) continue;
    if (!isElementNode(child)) return false;
    const element = child as XmlElement;
    if (element.namespaceURI !== wordNamespace || element.localName !== 'r' || !isSimpleTextRun(element)) return false;
    if (child === endRun) {
      betweenEndRuns = true;
      break;
    }
  }
  return betweenEndRuns;
}

function setWordAttribute(element: XmlElement, localName: string, value: string) {
  element.setAttributeNS(wordNamespace, `w:${localName}`, value);
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

function xmlText(document: XmlDocument, value: string) {
  const text = document.createElementNS(wordNamespace, 'w:t');
  const safeValue = xmlSafe(value);
  text.appendChild(document.createTextNode(safeValue));
  if (/^\s|\s$/.test(safeValue)) text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  return text;
}

function addCommentContent(document: XmlDocument, commentsRoot: XmlElement, id: number, annotations: WordCommentExportAnnotation[]) {
  const comment = document.createElementNS(wordNamespace, 'w:comment');
  setWordAttribute(comment, 'id', String(id));
  setWordAttribute(comment, 'author', 'Annotation Studio');
  setWordAttribute(comment, 'initials', 'AS');
  setWordAttribute(comment, 'date', new Date().toISOString());

  for (const annotation of annotations) {
    const lines = [
      `Label: ${annotation.label}`,
      annotation.reviewPriority ? `Review priority: ${annotation.reviewPriority}` : '',
      annotation.reason ? `Reason: ${annotation.reason}` : annotation.note ? `Note: ${annotation.note}` : '',
      annotation.excerpt ? `Evidence: ${annotation.excerpt}` : '',
    ].filter(Boolean);
    if (annotations.length > 1) {
      const heading = document.createElementNS(wordNamespace, 'w:p');
      const headingRun = document.createElementNS(wordNamespace, 'w:r');
      headingRun.appendChild(xmlText(document, `Annotation ${annotations.indexOf(annotation) + 1}`));
      heading.appendChild(headingRun);
      comment.appendChild(heading);
    }
    for (const line of lines) {
      const paragraph = document.createElementNS(wordNamespace, 'w:p');
      const run = document.createElementNS(wordNamespace, 'w:r');
      run.appendChild(xmlText(document, line));
      paragraph.appendChild(run);
      comment.appendChild(paragraph);
    }
  }
  commentsRoot.appendChild(comment);
}

function nextRelationshipId(root: XmlElement) {
  const used = new Set(Array.from(root.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship')).map((item) => item.getAttribute('Id')));
  let counter = 1;
  while (used.has(`rIdAnnotationStudio${counter}`)) counter += 1;
  return `rIdAnnotationStudio${counter}`;
}

function resolvePartPath(target: string) {
  const cleanTarget = target.replace(/^\/+/, '');
  const path = cleanTarget.startsWith('word/') ? posix.normalize(cleanTarget) : posix.normalize(posix.join('word', cleanTarget));
  if (path.startsWith('../') || path === '..' || path.startsWith('/')) throw new Error('Word comments relationship points outside the package.');
  return path;
}

/** Adds legacy-compatible Word comments to a new copy, anchoring unique excerpts when the Word structure permits it. */
export async function exportWordComments(source: Buffer, annotations: WordCommentExportAnnotation[]): Promise<WordCommentExportResult> {
  if (annotations.length > 500) throw Object.assign(new Error('Word comment export accepts at most 500 annotations.'), { status: 413 });
  const zip = await JSZip.loadAsync(source);
  const documentFile = zip.file('word/document.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!documentFile || !contentTypesFile) throw Object.assign(new Error('This file does not contain a valid Word document package.'), { status: 415 });

  const documentXml = await documentFile.async('string');
  const contentTypesXml = await contentTypesFile.async('string');
  const document = parseXml(documentXml, 'word/document.xml');
  const contentTypes = parseXml(contentTypesXml, '[Content_Types].xml');
  const wordRoot = document.documentElement;
  if (!wordRoot || wordRoot.namespaceURI !== wordNamespace || wordRoot.localName !== 'document') throw Object.assign(new Error('The Word main document part is invalid.'), { status: 415 });
  const contentTypesRoot = contentTypes.documentElement;
  if (!contentTypesRoot || contentTypesRoot.namespaceURI !== contentTypesNamespace || contentTypesRoot.localName !== 'Types') throw Object.assign(new Error('The Word content types part is invalid.'), { status: 415 });
  const paragraphs = getParagraphs(document);
  const paragraphIndexes = new Map<XmlElement, ParagraphTextIndex>();
  const paragraphStarts = new Map<XmlElement, number>();
  let fullDocumentText = '';
  for (const paragraph of paragraphs) {
    if (fullDocumentText) fullDocumentText += ' ';
    paragraphStarts.set(paragraph, fullDocumentText.length);
    const index = paragraphTextIndex(paragraph);
    paragraphIndexes.set(paragraph, index);
    fullDocumentText += index.text;
  }
  const groupsByParagraph = new Map<XmlElement, ParagraphCommentGroup[]>();
  const skipped: WordCommentExportResult['skipped'] = [];

  for (const annotation of annotations.slice(0, 500)) {
    // The page text selector survives the canonical adapter. Use its exact quote for
    // matching, then its surrounding quote to resolve repeated phrases when possible.
    const excerpt = annotation.textAnchor?.quote.exact || (typeof annotation.excerpt === 'string' ? annotation.excerpt : '');
    const query = normalizedText(excerpt);
    if (!query) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'missing_excerpt' });
      continue;
    }
    const matches: Array<{ paragraph: XmlElement; match: MatchedWordExcerpt; startIndex: number; globalStart: number }> = [];
    for (const paragraph of paragraphs) {
      const index = paragraphIndexes.get(paragraph)!;
      let fromIndex = 0;
      while (fromIndex <= index.text.length - query.length) {
        const foundAt = index.text.indexOf(query, fromIndex);
        if (foundAt < 0) break;
        const start = index.positions[foundAt];
        const end = index.positions[foundAt + query.length - 1];
        if (start && end) matches.push({ paragraph, match: { start, end }, startIndex: foundAt, globalStart: paragraphStarts.get(paragraph)! + foundAt });
        fromIndex = foundAt + 1;
      }
    }
    if (!matches.length) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'not_found' });
      continue;
    }
    let resolvedMatches = matches;
    const anchor = annotation.textAnchor?.quote;
    if (matches.length > 1 && anchor && (anchor.prefix.trim() || anchor.suffix.trim())) {
      const prefix = normalizedText(anchor.prefix);
      const suffix = normalizedText(anchor.suffix);
      const contextualMatches = matches.filter((candidate) => {
        // The exported page anchor and Word XML can use different runs/whitespace.
        // Read a few extra characters, then compare normalized context.
        const before = normalizedText(fullDocumentText.slice(Math.max(0, candidate.globalStart - prefix.length - 4), candidate.globalStart));
        const afterStart = candidate.globalStart + query.length;
        const after = normalizedText(fullDocumentText.slice(afterStart, Math.min(fullDocumentText.length, afterStart + suffix.length + 4)));
        const atDocumentStart = candidate.globalStart < prefix.length + 4;
        const atDocumentEnd = afterStart + suffix.length + 4 >= fullDocumentText.length;
        const prefixMatches = !prefix || (before.length > 0 && (before.endsWith(prefix) || (atDocumentStart && prefix.endsWith(before))));
        const suffixMatches = !suffix || (after.length > 0 && (after.startsWith(suffix) || (atDocumentEnd && suffix.startsWith(after))));
        return prefixMatches && suffixMatches;
      });
      if (contextualMatches.length) resolvedMatches = contextualMatches;
    }
    if (resolvedMatches.length > 1) {
      skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'ambiguous' });
      continue;
    }
    const { paragraph, match, startIndex } = resolvedMatches[0]!;
    const groups = groupsByParagraph.get(paragraph) ?? [];
    const endIndex = startIndex + query.length;
    const identicalRange = groups.find((group) => group.startIndex === startIndex && group.endIndex === endIndex);
    if (identicalRange) identicalRange.annotations.push(annotation);
    else groups.push({ annotations: [annotation], match, query, startIndex, endIndex });
    groupsByParagraph.set(paragraph, groups);
  }

  const safeGroups: ParagraphCommentGroup[] = [];
  for (const [paragraph, groups] of groupsByParagraph) {
    const overlapping = new Set<ParagraphCommentGroup>();
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const first = groups[left]!;
        const second = groups[right]!;
        if (first.startIndex < second.endIndex && second.startIndex < first.endIndex) {
          overlapping.add(first);
          overlapping.add(second);
        }
      }
    }
    for (const group of groups) {
      if (overlapping.has(group)) {
        for (const annotation of group.annotations) skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'ambiguous' });
      } else if (canInsertExactCommentRange(paragraph, group.match)) safeGroups.push(group);
      else {
        for (const annotation of group.annotations) skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'unsupported_structure' });
      }
    }
  }

  if (!safeGroups.length) return { buffer: source, commentsAdded: 0, annotationsAnchored: 0, skipped };

  const relationshipsPath = 'word/_rels/document.xml.rels';
  const relationshipsFile = zip.file(relationshipsPath);
  const relationships = relationshipsFile
    ? parseXml(await relationshipsFile.async('string'), relationshipsPath)
    : parseXml(`<Relationships xmlns="${packageRelationshipsNamespace}"/>`, relationshipsPath);
  const relationshipsRoot = relationships.documentElement;
  if (!relationshipsRoot || relationshipsRoot.namespaceURI !== packageRelationshipsNamespace || relationshipsRoot.localName !== 'Relationships') throw Object.assign(new Error('Word document relationships are invalid.'), { status: 415 });
  let commentsRelationship = Array.from(relationshipsRoot.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
    .find((item) => item.getAttribute('Type') === commentsRelationshipType);
  let commentsPath = commentsRelationship ? resolvePartPath(commentsRelationship.getAttribute('Target') ?? '') : 'word/comments.xml';
  let commentsFile = zip.file(commentsPath);
  if (!commentsRelationship) {
    commentsRelationship = relationships.createElementNS(packageRelationshipsNamespace, 'Relationship');
    commentsRelationship.setAttribute('Id', nextRelationshipId(relationshipsRoot));
    commentsRelationship.setAttribute('Type', commentsRelationshipType);
    commentsRelationship.setAttribute('Target', 'comments.xml');
    relationshipsRoot.appendChild(commentsRelationship);
  }
  if (!commentsFile) {
    zip.file(commentsPath, `<w:comments xmlns:w="${wordNamespace}"/>`);
    commentsFile = zip.file(commentsPath);
  }
  if (!commentsFile) throw new Error('Could not create the Word comments part.');
  const comments = parseXml(await commentsFile.async('string'), commentsPath);
  const commentsRoot = comments.documentElement;
  if (!commentsRoot || commentsRoot.namespaceURI !== wordNamespace || commentsRoot.localName !== 'comments') throw Object.assign(new Error('The Word comments part is invalid.'), { status: 415 });

  const overrides = Array.from(contentTypesRoot.getElementsByTagNameNS(contentTypesNamespace, 'Override'));
  const normalizedPartName = `/${commentsPath}`;
  if (!overrides.some((item) => item.getAttribute('PartName') === normalizedPartName)) {
    const override = contentTypes.createElementNS(contentTypesNamespace, 'Override');
    override.setAttribute('PartName', normalizedPartName);
    override.setAttribute('ContentType', commentsContentType);
    contentTypesRoot.appendChild(override);
  }

  let nextCommentId = Array.from(commentsRoot.getElementsByTagNameNS(wordNamespace, 'comment'))
    .reduce((maximum, comment) => {
      const id = Number(comment.getAttributeNS(wordNamespace, 'id'));
      return Number.isInteger(id) ? Math.max(maximum, id) : maximum;
    }, -1) + 1;
  let commentsAdded = 0;
  let annotationsAnchored = 0;
  for (const [paragraph, groups] of groupsByParagraph) {
    const paragraphSafeGroups = groups.filter((group) => safeGroups.includes(group)).sort((left, right) => right.startIndex - left.startIndex);
    for (const group of paragraphSafeGroups) {
      // Earlier anchors may have split the original Word runs. Rebuild the text index
      // against the live paragraph before inserting the next exact range. Splitting
      // runs preserves normalized text offsets, including context-resolved matches
      // when the same excerpt occurs more than once in this paragraph.
      const index = paragraphTextIndex(paragraph);
      const foundAt = group.startIndex;
      const start = index.positions[foundAt];
      const end = index.positions[group.endIndex - 1];
      const match = start && end ? { start, end } : null;
      if (index.text.slice(foundAt, group.endIndex) !== group.query || !match) {
        for (const annotation of group.annotations) skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'ambiguous' });
        continue;
      }
      if (!canInsertExactCommentRange(paragraph, match)) {
        for (const annotation of group.annotations) skipped.push({ annotationId: annotation.id, label: annotation.label, reason: 'unsupported_structure' });
        continue;
      }
      insertExactCommentRange(document, paragraph, match, nextCommentId);
      addCommentContent(comments, commentsRoot, nextCommentId, group.annotations);
      nextCommentId += 1;
      commentsAdded += 1;
      annotationsAnchored += group.annotations.length;
    }
  }

  if (!commentsAdded) return { buffer: source, commentsAdded: 0, annotationsAnchored: 0, skipped };

  const serializer = new XMLSerializer();
  zip.file('word/document.xml', serializer.serializeToString(document));
  zip.file(relationshipsPath, serializer.serializeToString(relationships));
  zip.file('[Content_Types].xml', serializer.serializeToString(contentTypes));
  zip.file(commentsPath, serializer.serializeToString(comments));
  const output = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer: output, commentsAdded, annotationsAnchored, skipped };
}
