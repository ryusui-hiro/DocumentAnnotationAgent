import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser as XmlParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { importStaticDocument, staticPackagePath, staticTextPages, staticImageMime, staticImageIsAnimated, STATIC_MAX_FILE_BYTES } from './staticDocuments';

globalThis.DOMParser = XmlParser as unknown as typeof DOMParser;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationships = (body: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const importZip = async (zip: JSZip, name: string) => importStaticDocument(new File([new Uint8Array(await zip.generateAsync({ type: 'uint8array' })).buffer], name));

test('browser Word import preserves text, tabs and breaks while escaping source markup', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>日本語 &amp; &lt;script&gt;alert(1)&lt;/script&gt;</w:t><w:tab/><w:t>After tab</w:t><w:br/><w:t>Next line</w:t></w:r><w:del><w:r><w:delText>Deleted text</w:delText></w:r></w:del></w:p></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', relationships('<Relationship Id="evil" Target="https://example.invalid/private" TargetMode="External"/>'));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; throw new Error('Network use is forbidden during import'); }) as typeof fetch;
  try {
    const result = await importZip(zip, 'body.docx');
    assert.equal(result.document.fileType, 'docx');
    assert.equal(result.document.demo, false);
    assert.equal(result.document.needsReview, true);
    assert.match(result.document.sourceHash!, /^[a-f\d]{64}$/);
    assert.equal(result.document.pageCount, result.svgs.length);
    assert.match(result.svgs[0], /日本語 &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;    After tab/);
    assert.match(result.svgs[0], />Next line<\/text>/);
    assert.doesNotMatch(result.svgs[0], /<script>|Deleted text|example\.invalid/);
    assert.match(result.document.warnings.join(' '), /Original pagination/);
    assert.ok(result.sourceBuffer.byteLength);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('PowerPoint follows presentation relationship order and never follows external slide sources', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="urn:p" xmlns:r="${R}"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relationships('<Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/>'));
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>First source slide</a:t></a:r></a:p></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Second source slide</a:t></a:r></a:p></p:sld>');
  const result = await importZip(zip, 'slides.pptx');
  assert.equal(result.document.pageCount, 2);
  assert.match(result.svgs[0], /Second source slide/);
  assert.match(result.svgs[1], /First source slide/);
  zip.file('ppt/_rels/presentation.xml.rels', relationships('<Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="https://example.invalid/slide.xml" TargetMode="External"/>'));
  await assert.rejects(importZip(zip, 'external.pptx'), /supported internal source/);
});

function workbookFixture(): JSZip {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<workbook xmlns="urn:x" xmlns:r="${R}"><sheets><sheet name="入力シート" r:id="sheet1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', relationships('<Relationship Id="sheet1" Target="worksheets/sheet1.xml"/>'));
  zip.file('xl/sharedStrings.xml', '<sst xmlns="urn:x"><si><r><t>Customer </t></r><r><t>name</t></r></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="urn:x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Named value</t></is></c><c r="C1" t="b"><v>1</v></c><c r="D1"><f>SUM(1,2)</f><v>3</v></c><c r="E1"><f>NOW()</f></c></row></sheetData></worksheet>');
  return zip;
}

test('Excel browser import retains cell addresses, rich/shared strings and formula cache distinctions', async () => {
  const result = await importZip(workbookFixture(), 'cells.xlsx');
  const content = result.svgs.join('');
  for (const expected of ['A1: Customer name', 'B1: Named value', 'C1: TRUE', 'D1: 3', 'E1: [Formula without a cached result: =NOW()]']) assert.ok(content.includes(expected), expected);
  assert.match(result.document.warnings.join(' '), /not recalculated/);
  assert.match(result.document.warnings.join(' '), /no cached result/);
  assert.match(content, /入力シート/);
});

test('Office imports reject malformed references, XML entities and oversized XML parts', async () => {
  const workbook = workbookFixture();
  workbook.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="urn:x"><c r="A1" t="s"><v>99</v></c></worksheet>');
  await assert.rejects(importZip(workbook, 'bad.xlsx'), /shared-string reference/);
  const word = new JSZip();
  word.file('word/document.xml', '<!DOCTYPE test [<!ENTITY e SYSTEM "https://example.invalid/secret">]><document>&e;</document>');
  await assert.rejects(importZip(word, 'entities.docx'), /entity declarations/);
  word.file('word/document.xml', ' '.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(importZip(word, 'large.docx'), /size limit/);
});

test('text previews preserve all Unicode content across bounded pages without source markup', () => {
  const words = Array.from({ length: 100 }, (_, index) => `Line ${index} 日本語😀 & <unsafe>`);
  const pages = staticTextPages('long document', words);
  assert.ok(pages.length > 1);
  const combined = pages.map((page) => page.svg).join('');
  for (const word of words) assert.ok(combined.includes(word.replace('&', '&amp;').replace('<unsafe>', '&lt;unsafe&gt;')));
  assert.doesNotMatch(combined, /<unsafe>/);
  assert.throws(() => staticTextPages('huge', Array(5000).fill('text')), /exceeds 120 pages/);
});

test('package targets stay inside their archive and image signatures are verified', () => {
  assert.equal(staticPackagePath('ppt/presentation.xml', 'slides/slide1.xml'), 'ppt/slides/slide1.xml');
  assert.equal(staticPackagePath('xl/workbook.xml', '/xl/worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  for (const target of ['../../secret', 'https://example.invalid/a', '//example.invalid/a', 'file:///secret', '..\\secret', 'slides/slide1.xml?secret']) assert.equal(staticPackagePath('ppt/presentation.xml', target), null);
  assert.equal(staticImageMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(staticImageMime(new Uint8Array([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(staticImageMime(new TextEncoder().encode('<svg/>')), null);
});

test('empty, unsupported and oversized browser imports fail before decoding', async () => {
  await assert.rejects(importStaticDocument(new File([], 'empty.pdf')), /empty/);
  await assert.rejects(importStaticDocument(new File(['<svg/>'], 'image.svg')), /Choose a PDF/);
  await assert.rejects(importStaticDocument(new File([new Uint8Array(STATIC_MAX_FILE_BYTES + 1)], 'large.pdf')), /30 MB/);
});

test('animation detection checks container metadata rather than compressed image contents', () => {
  const webp = new Uint8Array(24);
  webp.set(new TextEncoder().encode('VP8 '), 12); webp[20] = 2;
  assert.equal(staticImageIsAnimated(webp, 'image/webp'), false);
  webp.set(new TextEncoder().encode('VP8X'), 12);
  assert.equal(staticImageIsAnimated(webp, 'image/webp'), true);
  const png = new Uint8Array(32);
  new DataView(png.buffer).setUint32(8, 12);
  png.set(new TextEncoder().encode('IDAT'), 12); png.set(new TextEncoder().encode('acTL'), 16);
  assert.equal(staticImageIsAnimated(png, 'image/png'), false);
  png.set(new TextEncoder().encode('acTL'), 12);
  assert.equal(staticImageIsAnimated(png, 'image/png'), true);
});
