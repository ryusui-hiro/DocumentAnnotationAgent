import type { PaperBlock, PaperPageResult } from './paperOcrTypes';

export const confirmedWorkspaceBlock = (block: PaperBlock) => !block.provisional && !block.uncertain;

/** Stream and final IDs use the same run namespace; later runs cannot collide with retained human edits. */
export function scopeIntentResult(result: PaperPageResult, runId: string): PaperPageResult {
  return { ...result, blocks: result.blocks.map((block) => ({ ...block, id: `${runId}:${block.id}` })) };
}

/** A successful final model response replaces provisional/old AI output, while human work remains authoritative. */
export function reconcileIntentPage(previous: PaperPageResult | undefined, result: PaperPageResult): PaperPageResult {
  const humanBlocks = (previous?.blocks ?? []).filter((block) => block.source === 'manual' || block.editedByHuman);
  const humanIds = new Set(humanBlocks.map((block) => block.id));
  return { ...result, status: 'complete', blocks: [...humanBlocks, ...result.blocks.filter((block) => !humanIds.has(block.id)).map((block) => ({ ...block, source: 'ai' as const, provisional: false }))] };
}

export function markIntentPageIncomplete(page: PaperPageResult, error: string): PaperPageResult {
  return { ...page, status: 'incomplete', error, blocks: page.blocks.map((block) => block.provisional ? { ...block, uncertain: true, uncertaintyReason: block.uncertaintyReason || error } : block) };
}
