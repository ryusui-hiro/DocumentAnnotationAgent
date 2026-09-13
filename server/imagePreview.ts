import { extname } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { PreviewReport } from 'document-svg';

const imageFormats = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.webp', 'webp'],
  ['.tif', 'tiff'],
  ['.tiff', 'tiff'],
]);

export const rasterImageExtensions = new Set(imageFormats.keys());

const maxInputPixels = 40_000_000;
const maxImageEdge = 4096;
const maxPreviewBytes = 16 * 1024 * 1024;

function imageError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

/** Normalize one still raster image into a safe, self-contained SVG page. */
export async function previewRasterImage(originalName: string, input: Buffer): Promise<PreviewReport> {
  const startedAt = Date.now();
  const extension = extname(originalName).toLowerCase();
  const expectedFormat = imageFormats.get(extension);
  if (!expectedFormat) throw imageError('対応画像形式は PNG / JPEG / WebP / TIFF です。', 415);
  if (!input.length) throw imageError('画像ファイルが空です。', 400);

  let metadata: Metadata;
  try {
    metadata = await sharp(input, { failOn: 'error', limitInputPixels: maxInputPixels, sequentialRead: true }).metadata();
  } catch {
    throw imageError('画像を読み取れませんでした。ファイル形式と破損の有無を確認してください。', 415);
  }
  if (metadata.format !== expectedFormat) {
    throw imageError('拡張子と画像の実際の形式が一致しません。PNG / JPEG / WebP / TIFF の画像を選択してください。', 415);
  }
  if (metadata.pages && metadata.pages > 1) {
    throw imageError('アニメーション画像や複数ページTIFFには未対応です。1枚の画像に変換してから読み込んでください。', 415);
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxInputPixels) {
    throw imageError('画像サイズが大きすぎます。最大4,000万画素まで対応しています。', 413);
  }

  const resized = metadata.width > maxImageEdge || metadata.height > maxImageEdge;
  const pipeline = sharp(input, { failOn: 'error', limitInputPixels: maxInputPixels, sequentialRead: true })
    .rotate()
    .resize({ width: maxImageEdge, height: maxImageEdge, fit: 'inside', withoutEnlargement: true });
  const outputFormat = metadata.format === 'png' || metadata.format === 'tiff' || metadata.hasAlpha
    ? 'png'
    : metadata.format === 'webp' ? 'webp' : 'jpeg';
  const encoded = outputFormat === 'png'
    ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
    : outputFormat === 'webp'
      ? await pipeline.webp({ quality: 95, effort: 5 }).toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });

  if (encoded.data.byteLength > maxPreviewBytes) {
    throw imageError('プレビュー用の画像が大きすぎます。画像を小さくするか、JPEG / WebPに変換してから読み込んでください。', 413);
  }

  const mimeType = `image/${outputFormat}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${encoded.info.width}" height="${encoded.info.height}" viewBox="0 0 ${encoded.info.width} ${encoded.info.height}">`,
    `<image width="${encoded.info.width}" height="${encoded.info.height}" preserveAspectRatio="xMidYMid meet" href="data:${mimeType};base64,${encoded.data.toString('base64')}"/>`,
    '</svg>',
  ].join('');
  const warnings = resized ? [`画像をプレビュー用に最大${maxImageEdge}pxの範囲へ縮小しました。`] : [];
  const sourceFormat = metadata.format.toUpperCase();
  const elapsedMs = Date.now() - startedAt;

  return {
    converter: 'annotation-studio-raster-image',
    version: '1',
    source: originalName,
    sourceFormat,
    elapsedMs,
    inputBytes: input.byteLength,
    pageCount: 1,
    largestPageIrBytes: encoded.data.byteLength,
    pages: [{
      number: 1,
      svg,
      widthPoints: encoded.info.width,
      heightPoints: encoded.info.height,
      nodeCount: 1,
      warningCount: warnings.length,
      warnings,
      estimatedIrBytes: encoded.data.byteLength,
    }],
    warnings,
    needsReview: warnings.length > 0,
  };
}
