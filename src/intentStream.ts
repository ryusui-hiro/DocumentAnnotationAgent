import { readResponseJson } from './responseJson';
import { tr } from './i18n';
import type { PaperBlock, PaperPageResult } from './paperOcrTypes';
import { enforceHumanLabel, type HumanLabelRule } from './documentLabelRules';

const blockTypes = new Set(['region', 'title', 'heading', 'text', 'figure', 'table', 'equation', 'caption']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;

export function validatedIntentBlock(value: unknown): PaperBlock {
  if (!record(value) || !text(value.id, 200) || !value.id || !blockTypes.has(String(value.type))
    || !text(value.extractedText, 18_000) || !(value.latex === null || text(value.latex, 5_000))
    || typeof value.uncertain !== 'boolean' || !text(value.uncertaintyReason, 1_000)
    || (value.label !== undefined && !text(value.label, 200)) || (value.note !== undefined && !text(value.note, 5_000))
    || !record(value.bbox)) throw new Error('The AI returned an invalid annotation.');
  const { x, y, width, height } = value.bbox;
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))
    || (x as number) < 0 || (y as number) < 0 || (x as number) >= 1 || (y as number) >= 1
    || (width as number) <= 0 || (height as number) <= 0 || (width as number) > 1 || (height as number) > 1
    || (x as number) + (width as number) > 1.000001 || (y as number) + (height as number) > 1.000001) {
    throw new Error('The AI returned an annotation outside the page.');
  }
  return {
    id: value.id, type: value.type as PaperBlock['type'], bbox: { x: x as number, y: y as number, width: width as number, height: height as number },
    extractedText: value.extractedText, latex: value.latex as string | null, uncertain: value.uncertain, uncertaintyReason: value.uncertaintyReason,
    ...(typeof value.label === 'string' ? { label: value.label } : {}), ...(typeof value.note === 'string' ? { note: value.note } : {}), source: 'ai',
  };
}

function validatedResult(value: unknown, expectedPage: number, labelRules: readonly HumanLabelRule[] = []): PaperPageResult {
  if (!record(value) || value.pageNumber !== expectedPage || !Number.isInteger(value.sourcePageNumber) || Number(value.sourcePageNumber) < 1
    || !Array.isArray(value.blocks) || value.blocks.length > 60 || !Array.isArray(value.warnings)
    || !value.warnings.every((warning) => text(warning, 1_000)) || !text(value.model, 200)
    || !text(value.provider, 200) || !text(value.generatedAt, 100)) throw new Error('The AI returned an invalid final page result.');
  const blocks = value.blocks.map((block) => enforceHumanLabel(validatedIntentBlock(block), labelRules));
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) throw new Error('The final result contains duplicate annotation IDs.');
  return { ...value, blocks, status: 'complete' } as unknown as PaperPageResult;
}

export type IntentActivity = { phase: string; message: string; pageNumber: number };
export async function consumeIntentStream(response: Response, callbacks: {
  pageNumber: number;
  labelRules?: readonly HumanLabelRule[];
  onStart?: (value: Record<string, unknown>) => void;
  onActivity: (value: IntentActivity) => void;
  onBlock: (block: PaperBlock) => void;
}): Promise<PaperPageResult> {
  if (!response.ok) {
    const value: unknown = await readResponseJson(response);
    throw new Error(record(value) && typeof value.error === 'string' ? value.error : `Request failed (HTTP ${response.status}).`);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The AI endpoint did not return a live event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: PaperPageResult | undefined;
  let failed = false;
  const dispatch = (frame: string) => {
    let event = 'message';
    const lines: string[] = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
    }
    if (!lines.length) return;
    let value: unknown;
    try { value = JSON.parse(lines.join('\n')); } catch {
      throw new Error(tr({ ja: 'ライブ応答が途中で切れたか、形式が正しくありません。途中の注釈は未確定のまま保持します。ページを再実行してください。', en: 'The live response was interrupted or malformed. Partial annotations remain unconfirmed. Retry this page.', 'zh-CN': '实时响应已中断或格式不正确。部分注释保持未确认状态。请重试此页。' }));
    }
    if (!record(value)) throw new Error('The AI stream returned an invalid event.');
    if (value.pageNumber !== undefined && value.pageNumber !== callbacks.pageNumber) throw new Error('The AI stream returned a different page.');
    if (event === 'error') throw new Error(typeof value.error === 'string' ? value.error : 'The AI run failed.');
    if (event === 'start') callbacks.onStart?.(value);
    if (event === 'activity') callbacks.onActivity({ phase: typeof value.phase === 'string' ? value.phase : '', message: typeof value.message === 'string' ? value.message : typeof value.detail === 'string' ? value.detail : '', pageNumber: callbacks.pageNumber });
    if (event === 'block') callbacks.onBlock(enforceHumanLabel(validatedIntentBlock(value.block ?? value), callbacks.labelRules));
    if (event === 'complete') finalResult = validatedResult(value.result ?? value, callbacks.pageNumber, callbacks.labelRules);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw new Error('The AI stream exceeded its response limit.');
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/u)![0];
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + delimiter.length);
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!finalResult) throw new Error('The connection ended before the AI completed this page. Partial annotations still need review.');
    return finalResult;
  } catch (error) { failed = true; throw error; }
  finally { if (failed) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
