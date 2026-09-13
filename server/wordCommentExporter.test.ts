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
  zip.file('word/document.xml', options.documentXml ?? `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">Either party may </w:t></w:r><w:r><w:t>terminate at any time.</w:t></w:r></w:p><w:p><w:r><w:t>Repeated claim without evidence.</w:t></w:r></w:p><w:p><w:r><w:t>Repeated claim without evidence.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  if (options.commentsXml) zip.file('word/comments.xml', options.commentsXml);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
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

test('uses one paragraph anchor when several annotations target the same paragraph', async () => {
  const source = await makeDocx();
  const exported = await exportWordComments(source, [
    { id: 'comment-first', label: 'Right holder', note: '', excerpt: 'Either party may' },
    { id: 'comment-second', label: 'Termination timing', note: '', excerpt: 'terminate at any time' },
  ]);
  assert.equal(exported.commentsAdded, 1);
  assert.equal(exported.annotationsAnchored, 2);
  const zip = await JSZip.loadAsync(exported.buffer);
  const document = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const paragraph = document.getElementsByTagNameNS(W, 'p').item(0)! as unknown as TestXmlElement;
  const start = paragraph.getElementsByTagNameNS(W, 'commentRangeStart').item(0)!;
  const end = paragraph.getElementsByTagNameNS(W, 'commentRangeEnd').item(0)!;
  const textBeforeStart = Array.from(paragraph.getElementsByTagNameNS(W, 't')).map((node) => node.textContent ?? '').join('');
  assert.equal(textBeforeStart, 'Either party may terminate at any time.');
  assert.ok(start && end);
});

test('reports an excerpt repeated twice in one paragraph as ambiguous', async () => {
  const documentXml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Either party may terminate; either party may terminate again.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  const source = await makeDocx({ documentXml });
  const exported = await exportWordComments(source, [{ id: 'same-paragraph-duplicate', label: 'Termination', note: '', excerpt: 'either party may terminate' }]);
  assert.equal(exported.commentsAdded, 0);
  assert.deepEqual(exported.skipped, [{ annotationId: 'same-paragraph-duplicate', label: 'Termination', reason: 'ambiguous' }]);
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
  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  const entries = Array.from(comments.getElementsByTagNameNS(W, 'comment'));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((comment) => comment.getAttributeNS(W, 'id')), ['0', '1']);
  assert.match(comments.documentElement?.textContent ?? '', /Existing comment/);
});
