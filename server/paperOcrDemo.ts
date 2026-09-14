import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PreviewReport } from 'document-svg';

/** Pre-rendered source pages keep embedded math glyphs intact in the demo. */
export async function loadPaperOcrDemoPreview(directory = resolve('public/demos')): Promise<PreviewReport> {
  const report = JSON.parse(await readFile(resolve(directory, 'openai-paper-preview.json'), 'utf8')) as PreviewReport;
  if (report.sourceFormat !== 'pdf' || report.pageCount !== 3 || report.pages.length !== 3
    || report.pages.some((page, index) => page.number !== index + 1 || !page.svg.startsWith('<svg ') || page.widthPoints <= 0 || page.heightPoints <= 0)) {
    throw new Error('The prepared research-paper preview is invalid. Rebuild the paper demo.');
  }
  return report;
}
