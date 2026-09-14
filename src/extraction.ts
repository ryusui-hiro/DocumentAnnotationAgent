import type { Annotation, ConvertedDocument, NormalizedTextBox } from './types';
import { annotationReviewStatus } from './annotationStatus';

export function extractableAnnotations(annotations: Annotation[]) {
  return annotations.filter((item) => !['needs_review', 'rejected'].includes(annotationReviewStatus(item)))
    .sort((a, b) => a.pageNumber - b.pageNumber || a.y - b.y || a.x - b.x);
}

export function safeExtractionName(label: string) {
  return label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 64) || 'annotation';
}

export function cropPixels(box: NormalizedTextBox, imageWidth: number, imageHeight: number) {
  if (![box.x, box.y, box.width, box.height, imageWidth, imageHeight].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0 || imageWidth < 1 || imageHeight < 1) {
    throw new Error('抽出範囲の座標が正しくありません。');
  }
  const left = Math.max(0, Math.floor(box.x * imageWidth));
  const top = Math.max(0, Math.floor(box.y * imageHeight));
  const right = Math.min(imageWidth, Math.ceil((box.x + box.width) * imageWidth));
  const bottom = Math.min(imageHeight, Math.ceil((box.y + box.height) * imageHeight));
  if (right <= left || bottom <= top) throw new Error('抽出範囲がページの外にあります。');
  return { left, top, width: right - left, height: bottom - top };
}

function literal(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

export function excerptsMarkdown(fileName: string, annotations: Annotation[]) {
  const rows = extractableAnnotations(annotations);
  return [`# ${literal(fileName)} — 抽出ノート`, '', `${rows.length} 件の確定注釈。原文が記録されていない範囲は画像を参照してください。`, '',
    ...rows.flatMap((item, i) => [
      `## ${i + 1}. ${literal(item.label || 'ラベルなし')} · P.${item.pageNumber}`, '',
      ...(item.excerpt ? item.excerpt.split(/\r?\n/).map((line) => `> ${literal(line)}`) : ['原文テキストの記録なし']), '',
      ...(item.note ? [literal(item.note), ''] : []),
      ...(item.reason ? [`判断理由: ${literal(item.reason)}`, ''] : []),
    ]), ''].join('\n');
}

export async function loadExtractionImage(url: string) {
  const image = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('抽出用のページ画像を読み込めませんでした。'));
  });
  image.src = url;
  return loaded;
}

export async function cropAnnotationImage(image: HTMLImageElement, annotation: NormalizedTextBox) {
  const bounds = cropPixels(annotation, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('画像の抽出を開始できませんでした。');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNGを作成できませんでした。')), 'image/png'));
}

export async function createExtractionArchive(args: {
  document: ConvertedDocument;
  annotations: Annotation[];
  loadPage: (pageNumber: number) => Promise<string>;
  onProgress: (done: number, total: number) => void;
}) {
  const annotations = extractableAnnotations(args.annotations);
  if (!annotations.length) throw new Error('抽出できる確定注釈がありません。');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const manifest = [];
  let currentPage = 0;
  let image: HTMLImageElement | null = null;
  for (const [index, annotation] of annotations.entries()) {
    if (annotation.pageNumber !== currentPage) {
      image = await loadExtractionImage(await args.loadPage(annotation.pageNumber));
      currentPage = annotation.pageNumber;
    }
    const path = `regions/${String(index + 1).padStart(3, '0')}-p${currentPage}-${safeExtractionName(annotation.label)}.png`;
    const crop = await cropAnnotationImage(image!, annotation);
    zip.file(path, await crop.arrayBuffer());
    manifest.push({ ...annotation, image: path });
    args.onProgress(index + 1, annotations.length);
  }
  zip.file('notes.md', excerptsMarkdown(args.document.fileName, annotations));
  zip.file('manifest.json', JSON.stringify({ schemaVersion: 1, document: { fileName: args.document.fileName, sourceHash: args.document.sourceHash, pageCount: args.document.pageCount }, annotations: manifest }, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}
