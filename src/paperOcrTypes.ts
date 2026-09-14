import type { ConvertedDocument, TokenUsage } from './types';

export type PaperBlockType = 'region' | 'title' | 'heading' | 'text' | 'figure' | 'table' | 'equation' | 'caption';
export interface PaperBlock {
  id: string;
  type: PaperBlockType;
  bbox: { x: number; y: number; width: number; height: number };
  extractedText: string;
  latex: string | null;
  uncertain: boolean;
  uncertaintyReason: string;
  label?: string;
  note?: string;
  source?: 'manual' | 'ai';
  /** Streamed findings remain provisional until a successful final result or explicit human confirmation. */
  provisional?: boolean;
  editedByHuman?: boolean;
}
export interface PaperPageResult {
  pageNumber: number;
  sourcePageNumber: number;
  blocks: PaperBlock[];
  warnings: string[];
  model: string;
  provider: string;
  generatedAt: string;
  usage?: TokenUsage;
  status?: 'unprocessed' | 'manual' | 'running' | 'complete' | 'incomplete';
  error?: string;
}
export interface PaperOcrDemo {
  document: ConvertedDocument;
  paper: { title: string; authors?: string | string[]; sourceUrl: string; pdfUrl: string; sourcePages: number[]; license?: string; description?: string };
  pages: PaperPageResult[];
  provenance: Record<string, unknown>;
}

export const paperBlockColors: Record<PaperBlockType, string> = {
  region: '#248d81', title: '#d85d48', heading: '#825b39', text: '#557fbd', figure: '#8868b5', table: '#248d81', equation: '#bf811f', caption: '#74826d',
};

/** Keep source transcription exact; classification labels are stable language-independent keys. */
export function paperOcrMarkdown(demo: PaperOcrDemo) {
  const fence = (text: string, language = '') => {
    const maxRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const ticks = '`'.repeat(maxRun + 1);
    return `${ticks}${language}\n${text}\n${ticks}`;
  };
  return ['# Document annotations', '', fence(demo.paper.title), '', ...(demo.paper.sourceUrl ? [`Source: ${demo.paper.sourceUrl}`] : []), ...(demo.paper.pdfUrl ? [`PDF: ${demo.paper.pdfUrl}`] : []), '',
    ...demo.pages.flatMap((page) => [
      `## Source page ${page.sourcePageNumber}`, '', ...(page.model ? [`Model: ${page.model} · ${page.generatedAt}`, ''] : []), ...(page.status === 'incomplete' || page.status === 'running' ? ['Status: INCOMPLETE — provisional results require review.', ''] : []),
      ...page.blocks.flatMap((block, index) => [
        `### ${index + 1}. ${block.type}${block.uncertain || block.provisional ? ' — NEEDS REVIEW' : ''}${block.editedByHuman ? ' — EDITED' : ''}`, '',
        ...(block.label ? ['Label:', fence(block.label), ''] : []), ...(block.note ? ['Note:', fence(block.note), ''] : []),
        fence(block.extractedText), '', ...(block.latex ? [fence(block.latex, 'latex'), ''] : []),
      ]),
    ]), ''].join('\n');
}
