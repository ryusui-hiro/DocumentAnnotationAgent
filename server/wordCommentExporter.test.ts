import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type { PreviewReport } from 'document-svg';
import { PagedDocumentAdapter } from './documentAdapter';
import { exportWordComments } from './wordCommentExporter';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const COMMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
type TestXmlElement = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

async function makeDocx(options: { commentsXml?: string; commentsRelationship?: string; documentXml?: string } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${options.commentsXml ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${RELS}"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${options.commentsRelationship ?? ''}</Relationships>`);
  zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file('word/media/keep.bin', Buffer.from([0, 1, 2, 3, 255]));
  zip.file('word/document.xml', options.documentXml ?? `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">Either party may </w:t></w:r><w:r><w:t>terminate at any time.</w:t></w:r></w:p><w:p><w:r><w:t>Repeated claim without evidence.</w:t></w:r></w:p><w:p><w:r><w:t>Repeated claim without evidence.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  if (options.commentsXml) zip.file('word/comments.xml', options.commentsXml);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

function selectedCommentTextById(paragraph: TestXmlElement) {
  const selections = new Map<string, string>();
  let activeId: string | null = null;
  let selected = '';
  for (let child = paragraph.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== child.ELEMENT_NODE) continue;
    const element = child as unknown as TestXmlElement;
    if (element.namespaceURI === W && element.localName === 'commentRangeStart') {
      activeId = element.getAttributeNS(W, 'id');
      selected = '';
      continue;
    }
    if (element.namespaceURI === W && element.localName === 'commentRangeEnd') {
      if (activeId !== null && element.getAttributeNS(W, 'id') === activeId) selections.set(activeId, selected);
      activeId = null;
      selected = '';
      continue;
    }
    if (activeId !== null && element.namespaceURI === W && element.localName === 'r') {
      const textNodes = element.getElementsByTagNameNS(W, 't');
      for (let index = 0; index < textNodes.length; index += 1) selected += textNodes.item(index)?.textContent ?? '';
    }
  }
  return selections;
}

test('the shared DocumentAdapter exports canonical records as Word comments', async () => {
  const source = await makeDocx();
  const original = Buffer.from(source);
  const report = {
    sourceFormat: 'DOCX', pageCount: 1,
    pages: [{ number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg/>' }],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('contract.docx', report, 'doc-1', source);
  adapter.annotate({
    id: 'adapter-word-1', documentId: 'doc-1',
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 } },
    label: 'HIGH RISK', evidence: 'Either party may terminate at any time.', explanation: 'The termination right is unrestricted.',
    reviewPriority: 'medium', status: 'auto', excerpt: 'Either party may terminate at any time.', reason: 'Unrestricted termination right.', note: 'Review termination clause.',
  });

  const exported = await adapter.export({ format: 'native-annotated' });
  assert.equal(exported.fileName, 'contract-annotated.docx');
  assert.equal(exported.annotationsExported, 1);
  assert.equal(exported.metadata?.commentsAdded, 1);
  assert.deepEqual(source, original);
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.ok(zip.file('word/comments.xml'));
});

test('the shared DocumentAdapter passes text-anchor context to disambiguate a repeated Word excerpt', async () => {
  const source = await makeDocx({ documentXml: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Context A: Repeated claim without evidence. first follow up.</w:t></w:r></w:p><w:p><w:r><w:t>Context B: Repeated claim without evidence. other follow up.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` });
  const report = {
    sourceFormat: 'DOCX', pageCount: 1,
    pages: [{ number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg/>' }],
  } as unknown as PreviewReport;
  const adapter = new PagedDocumentAdapter('contract.docx', report, 'doc-1', source);
  const exact = 'Repeated claim without evidence.';
  const prefix = 'Context B: ';
  const suffix = ' other follow up.';
  adapter.annotate({
    id: 'adapter-word-context', documentId: 'doc-1',
    target: {
      kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
      textAnchor: { quote: { exact, prefix, suffix }, position: { start: 10, end: 43, unit: 'normalized-page-text' } },
    },
    label: 'Supported claim', evidence: exact, explanation: 'The second occurrence is supported by context.',
    reviewPriority: 'low', status: 'auto', excerpt: exact,
  });

  const exported = await adapter.export({ format: 'native-annotated' });
  assert.equal(exported.annotationsExported, 1);
  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const start = document.getElementsByTagNameNS(W, 'commentRangeStart').item(0)!;
  const paragraph = start.parentNode as unknown as TestXmlElement;
  const paragraphText = Array.from(paragraph.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('');
  assert.match(paragraphText, /Context B:/u);
  assert.doesNotMatch(paragraphText, /Context A:/u);
});

test('writes excerpt-anchored comments to a new DOCX copy and reports unmatched excerpts', async () => {
  const source = await makeDocx();
  const original = Buffer.from(source);
  const exported = await exportWordComments(source, [
    { id: 'comment-1', label: 'HIGH RISK', note: 'The clause is one-sided.', reason: 'Either party has an unconditional termination right.', excerpt: 'Either party may terminate at any time.', reviewPriority: 'medium' },
    { id: 'comment-missing', label: 'Unmatched', note: '', excerpt: 'No such phrase appears.' },
    { id: 'comment-ambiguous', label: 'Ambiguous', note: '', excerpt: 'Repeated claim without evidence.' },
  ]);
  assert.equal(exported.commentsAdded, 1);
  assert.equal(exported.annotationsAnchored, 1);
  assert.deepEqual(exported.skipped.map((item) => item.reason), ['not_found', 'ambiguous']);
  assert.deepEqual(source, original, 'source bytes are immutable');

  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const starts = document.getElementsByTagNameNS(W, 'commentRangeStart');
  const ends = document.getElementsByTagNameNS(W, 'commentRangeEnd');
  const references = document.getElementsByTagNameNS(W, 'commentReference');
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(references.length, 1);
  assert.equal(starts.item(0)?.getAttributeNS(W, 'id'), ends.item(0)?.getAttributeNS(W, 'id'));
  assert.equal(starts.item(0)?.getAttributeNS(W, 'id'), references.item(0)?.getAttributeNS(W, 'id'));

  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  assert.equal(comments.getElementsByTagNameNS(W, 'comment').length, 1);
  assert.match(comments.documentElement?.textContent ?? '', /HIGH RISK/);
  assert.match(comments.documentElement?.textContent ?? '', /unconditional termination right/);
  assert.match(comments.documentElement?.textContent ?? '', /Either party may terminate at any time/);

  const relations = new DOMParser().parseFromString(await zip.file('word/_rels/document.xml.rels')!.async('string'), 'application/xml');
  assert.equal(Array.from(relations.getElementsByTagNameNS(RELS, 'Relationship')).some((item) => item.getAttribute('Type') === COMMENT_REL && item.getAttribute('Target') === 'comments.xml'), true);
  const types = new DOMParser().parseFromString(await zip.file('[Content_Types].xml')!.async('string'), 'application/xml');
  assert.equal(Array.from(types.getElementsByTagNameNS(TYPES, 'Override')).some((item) => item.getAttribute('PartName') === '/word/comments.xml'), true);
});

test('anchors only the matched excerpt across split Word runs and preserves surrounding text', async () => {
  const documentXml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Unselected introduction: the </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">termination right</w:t></w:r><w:r><w:t xml:space="preserve"> is broad and unconditional.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  const source = await makeDocx({ documentXml });
  const exported = await exportWordComments(source, [{
    id: 'comment-exact', label: 'HIGH RISK', note: '', excerpt: 'the termination right',
  }]);
  assert.equal(exported.annotationsAnchored, 1);

  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const start = document.getElementsByTagNameNS(W, 'commentRangeStart').item(0)!;
  const end = document.getElementsByTagNameNS(W, 'commentRangeEnd').item(0)!;
  const paragraph = start.parentNode as unknown as TestXmlElement;
  let withinRange = false;
  let selectedText = '';
  let selectedBoldRuns = 0;
  let selectedItalicRuns = 0;
  for (let child = paragraph.firstChild; child; child = child.nextSibling) {
    if (child === start) {
      withinRange = true;
      continue;
    }
    if (child === end) break;
    if (withinRange && child.nodeType === 1 && (child as unknown as TestXmlElement).localName === 'r') {
      const run = child as unknown as TestXmlElement;
      const textNodes = run.getElementsByTagNameNS(W, 't');
      for (let index = 0; index < textNodes.length; index += 1) selectedText += textNodes.item(index)?.textContent ?? '';
      if (run.getElementsByTagNameNS(W, 'b').length) selectedBoldRuns += 1;
      if (run.getElementsByTagNameNS(W, 'i').length) selectedItalicRuns += 1;
    }
  }
  assert.equal(selectedText, 'the termination right');
  const allText = Array.from(document.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('');
  assert.equal(allText, 'Unselected introduction: the termination right is broad and unconditional.');
  assert.equal(selectedBoldRuns, 1, 'the selected bold run retains its formatting');
  assert.equal(selectedItalicRuns, 1, 'the selected italic run retains its formatting');
});

test('keeps disjoint excerpts as separate exact comment anchors in the same paragraph', async () => {
  const source = await makeDocx();
  const exported = await exportWordComments(source, [
    { id: 'comment-first', label: 'Right holder', note: '', excerpt: 'Either party may' },
    { id: 'comment-second', label: 'Termination timing', note: '', excerpt: 'terminate at any time' },
  ]);
  assert.equal(exported.commentsAdded, 2);
  assert.equal(exported.annotationsAnchored, 2);
  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const paragraph = document.getElementsByTagNameNS(W, 'p').item(0)! as unknown as TestXmlElement;
  const selections = selectedCommentTextById(paragraph);
  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  const labelsById = new Map(Array.from(comments.getElementsByTagNameNS(W, 'comment')).map((comment) => [
    comment.getAttributeNS(W, 'id') ?? '',
    (comment.getElementsByTagNameNS(W, 't').item(0)?.textContent ?? '').replace(/^Label: /, ''),
  ]));
  const selectedByLabel = new Map([...selections].map(([id, selected]) => [labelsById.get(id) ?? '', selected]));
  assert.deepEqual(selectedByLabel.get('Right holder'), 'Either party may');
  assert.deepEqual(selectedByLabel.get('Termination timing'), 'terminate at any time');
  assert.equal(paragraph.getElementsByTagNameNS(W, 'commentRangeStart').length, 2);
  assert.equal(paragraph.getElementsByTagNameNS(W, 'commentRangeEnd').length, 2);
});

test('skips overlapping excerpts rather than broadening either anchor', async () => {
  const source = await makeDocx({ documentXml: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>the termination right is broad</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` });
  const exported = await exportWordComments(source, [
    { id: 'overlap-one', label: 'First', note: '', excerpt: 'termination right' },
    { id: 'overlap-two', label: 'Second', note: '', excerpt: 'right is broad' },
  ]);
  assert.equal(exported.buffer, source);
  assert.equal(exported.commentsAdded, 0);
  assert.equal(exported.annotationsAnchored, 0);
  assert.deepEqual(exported.skipped.map(({ annotationId, reason }) => ({ annotationId, reason })), [
    { annotationId: 'overlap-one', reason: 'ambiguous' },
    { annotationId: 'overlap-two', reason: 'ambiguous' },
  ]);
});

test('does not fall back to a full paragraph anchor when the exact excerpt is inside a hyperlink', async () => {
  const source = await makeDocx({ documentXml: `<w:document xmlns:w="${W}"><w:body><w:p><w:hyperlink w:anchor="section"><w:r><w:t>Unique linked excerpt</w:t></w:r></w:hyperlink><w:r><w:t> surrounding text</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` });
  const exported = await exportWordComments(source, [{ id: 'nested-run', label: 'Link', note: '', excerpt: 'Unique linked excerpt' }]);
  assert.equal(exported.buffer, source);
  assert.equal(exported.commentsAdded, 0);
  assert.equal(exported.annotationsAnchored, 0);
  assert.deepEqual(exported.skipped, [{ annotationId: 'nested-run', label: 'Link', reason: 'unsupported_structure' }]);
});

test('reports an excerpt repeated twice in one paragraph as ambiguous', async () => {
  const documentXml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Either party may terminate; either party may terminate again.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  const source = await makeDocx({ documentXml });
  const exported = await exportWordComments(source, [{ id: 'same-paragraph-duplicate', label: 'Termination', note: '', excerpt: 'either party may terminate' }]);
  assert.equal(exported.commentsAdded, 0);
  assert.deepEqual(exported.skipped, [{ annotationId: 'same-paragraph-duplicate', label: 'Termination', reason: 'ambiguous' }]);
});

test('retains context-resolved positions for repeated excerpts while splitting the same Word paragraph', async () => {
  const paragraphText = 'First party: may terminate after notice. Second party: may terminate immediately.';
  const source = await makeDocx({ documentXml: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${paragraphText}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` });
  const annotations = [
    { id: 'first-party', label: 'Notice required', prefix: 'First party: ', suffix: ' after notice.' },
    { id: 'second-party', label: 'Immediate termination', prefix: 'Second party: ', suffix: ' immediately.' },
  ].map(({ id, label, prefix, suffix }) => ({
    id, label, note: '', excerpt: 'may terminate',
    textAnchor: {
      quote: { exact: 'may terminate', prefix, suffix },
      position: { start: 0, end: 13, unit: 'normalized-page-text' as const },
    },
  }));

  const exported = await exportWordComments(source, annotations);
  assert.equal(exported.annotationsAnchored, 2, 'both contextual occurrences survive the live index rebuild');
  assert.equal(exported.commentsAdded, 2);
  assert.deepEqual(exported.skipped, []);
  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const paragraph = document.getElementsByTagNameNS(W, 'p').item(0)! as unknown as TestXmlElement;
  const allText = Array.from(paragraph.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('');
  assert.equal(allText, paragraphText, 'splitting formatted runs leaves the original text unchanged');
  const selections = selectedCommentTextById(paragraph);
  assert.deepEqual([...selections.values()], ['may terminate', 'may terminate']);
  const precedingTextById = new Map<string, string>();
  let precedingText = '';
  for (const child of Array.from(paragraph.childNodes)) {
    if (child.nodeType !== child.ELEMENT_NODE) continue;
    const element = child as TestXmlElement;
    if (element.namespaceURI === W && element.localName === 'commentRangeStart') {
      precedingTextById.set(element.getAttributeNS(W, 'id') ?? '', precedingText);
    }
    precedingText += Array.from(element.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('');
  }
  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  for (const comment of Array.from(comments.getElementsByTagNameNS(W, 'comment'))) {
    const label = comment.getElementsByTagNameNS(W, 't').item(0)?.textContent;
    const prefix = precedingTextById.get(comment.getAttributeNS(W, 'id') ?? '') ?? '';
    assert.ok(prefix.endsWith(label === 'Label: Notice required' ? 'First party: ' : 'Second party: '), 'each comment is attached to its context-selected occurrence');
  }
  assert.equal(paragraph.getElementsByTagNameNS(W, 'b').length, 5, 'all split pieces retain bold formatting');
});

test('does not let missing document-edge context select the wrong repeated Word excerpt', async () => {
  const documentXml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Repeated claim without evidence. matching suffix.</w:t></w:r></w:p><w:p><w:r><w:t>Context B: Repeated claim without evidence. incorrect suffix.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  const source = await makeDocx({ documentXml });
  const exported = await exportWordComments(source, [{
    id: 'edge-context-mismatch', label: 'Supported claim', note: '', excerpt: 'Repeated claim without evidence.',
    textAnchor: {
      quote: { exact: 'Repeated claim without evidence.', prefix: 'Context B: ', suffix: ' matching suffix.' },
      position: { start: 0, end: 33, unit: 'normalized-page-text' },
    },
  }]);
  assert.equal(exported.commentsAdded, 0);
  assert.equal(exported.annotationsAnchored, 0);
  assert.deepEqual(exported.skipped, [{ annotationId: 'edge-context-mismatch', label: 'Supported claim', reason: 'ambiguous' }]);
  assert.deepEqual(exported.buffer, source);
});

test('preserves existing Word comments and allocates a new comment id', async () => {
  const source = await makeDocx({
    commentsRelationship: `<Relationship Id="rIdComments" Type="${COMMENT_REL}" Target="comments.xml"/>`,
    commentsXml: `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Existing comment</w:t></w:r></w:p></w:comment></w:comments>`,
  });
  const exported = await exportWordComments(source, [{
    id: 'comment-new', label: 'Supported claim', note: 'Backed by the source.', reason: 'The source directly states this.',
    excerpt: 'Either party may terminate at any time.', reviewPriority: 'low',
  }]);
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.deepEqual(await zip.file('word/styles.xml')!.async('nodebuffer'), await (await JSZip.loadAsync(source)).file('word/styles.xml')!.async('nodebuffer'));
  assert.deepEqual(await zip.file('word/media/keep.bin')!.async('nodebuffer'), Buffer.from([0, 1, 2, 3, 255]));
  const relations = new DOMParser().parseFromString(await zip.file('word/_rels/document.xml.rels')!.async('string'), 'application/xml');
  assert.equal(Array.from(relations.getElementsByTagNameNS(RELS, 'Relationship')).some((item) => item.getAttribute('Id') === 'rIdStyles' && item.getAttribute('Type') === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles' && item.getAttribute('Target') === 'styles.xml'), true);
  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  const entries = Array.from(comments.getElementsByTagNameNS(W, 'comment'));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((comment) => comment.getAttributeNS(W, 'id')), ['0', '1']);
  assert.match(comments.documentElement?.textContent ?? '', /Existing comment/);
});

test('removes XML 1.0-invalid control characters from Word comment text fields', async () => {
  const source = await makeDocx();
  const exported = await exportWordComments(source, [{
    id: 'xml-control', label: 'HIGH\u0001RISK', note: 'note\u0002 text',
    reason: 'reason\u0003 text', excerpt: 'Either party\u000b may',
  }]);
  assert.equal(exported.commentsAdded, 1);
  assert.equal(exported.annotationsAnchored, 1);
  const zip = await JSZip.loadAsync(exported.buffer);
  const commentsXml = await zip.file('word/comments.xml')!.async('string');
  assert.doesNotMatch(commentsXml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u);
  const comments = new DOMParser().parseFromString(commentsXml, 'application/xml');
  const text = Array.from(comments.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('\n');
  assert.match(text, /Label: HIGHRISK/u);
  assert.match(text, /Reason: reason text/u);
  assert.match(text, /Evidence: Either party may/u);
});
