import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient, readFinalAgentMessage } from './codexAppServer';

import { IntentBlockStream, createIntentAnnotationOutputSchema, intentAnnotationPrompt, streamCallbacks, validateInput, zeroUsage, type IntentAnnotationInput, type IntentAnnotationResult } from '../src/intentAnnotation';
export * from '../src/intentAnnotation';

type IntentAppServerMessage = { method?: string; params?: Record<string, unknown> };
export type IntentAppServerClient = {
  initialize(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onNotification(handler: (message: IntentAppServerMessage) => void): () => void;
  onceNotification<T>(method: string, predicate: (params: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<T>;
  close(): void;
};

export async function runIntentAnnotationWithCodex(
  args: IntentAnnotationInput,
  createClient: () => IntentAppServerClient = () => new AppServerClient(),
): Promise<IntentAnnotationResult> {
  validateInput(args);
  if (process.env.CODEX_APP_SERVER_DISABLED === 'true') throw new Error('Codex App Server is disabled.');
  const model = args.model || 'gpt-6-astra';
  const directory = await mkdtemp(join(tmpdir(), 'annotation-intent-'));
  const imagePath = join(directory, 'page.png');
  const client = createClient();
  const scanners = new Map<string, IntentBlockStream>();
  const ignoredItems = new Set<string>();
  const onBlock = streamCallbacks(args);
  let usage = zeroUsage();
  let streamError: unknown;
  const abort = () => client.close();
  args.signal?.addEventListener('abort', abort, { once: true });
  try {
    args.signal?.throwIfAborted();
    await writeFile(imagePath, Buffer.from(args.imageDataUrl.split(',')[1]!, 'base64'));
    await client.initialize();
    const started = await client.request<{ thread: { id: string } }>('thread/start', { model, sandbox: 'read-only', approvalPolicy: 'never' });
    const threadId = started.thread?.id;
    if (!threadId) throw new Error('Codex did not return an annotation thread ID.');
    client.onNotification((message) => {
      if (message.params?.threadId !== threadId) return;
      try {
        if (message.method === 'thread/tokenUsage/updated') {
          const last = (message.params.tokenUsage as { last?: Record<string, number> } | undefined)?.last;
          if (last) usage = { inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0, reasoningTokens: last.reasoningOutputTokens ?? 0, cachedInputTokens: last.cachedInputTokens ?? 0, totalTokens: last.totalTokens ?? 0 };
        } else if (message.method === 'item/started') {
          const item = message.params.item as { id?: string; type?: string; phase?: string } | undefined;
          if (item?.type === 'agentMessage' && item.phase === 'commentary' && item.id) ignoredItems.add(item.id);
        } else if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string') {
          const itemId = String(message.params.itemId ?? 'final');
          if (ignoredItems.has(itemId)) return;
          let scanner = scanners.get(itemId);
          if (!scanner) { scanner = new IntentBlockStream(args.pageNumber, onBlock, args.labelRules); scanners.set(itemId, scanner); }
          scanner.push(message.params.delta);
        }
      } catch (error) { streamError = error; client.close(); }
    });
    const completed = client.onceNotification<{ turn: { id?: string; status?: string; items?: Array<{ type: string; text?: string; id?: string; phase?: string }> } }>('turn/completed', (params) => params.threadId === threadId, 240000);
    args.onActivity?.({ phase: 'analyzing', message: 'The model is reading the page and following your instruction.' });
    await client.request('turn/start', {
      threadId, model, effort: args.reasoningEffort || 'medium', outputSchema: createIntentAnnotationOutputSchema(args.labelRules),
      input: [{ type: 'text', text: intentAnnotationPrompt(args.instruction, args.labelRules), text_elements: [] }, { type: 'localImage', path: imagePath, detail: 'high' }],
    });
    const turn = await completed;
    args.signal?.throwIfAborted();
    if (streamError) throw streamError;
    const finalText = await readFinalAgentMessage(client, threadId, turn);
    const finalItem = [...(turn.turn.items ?? [])].reverse().find((item) => item.type === 'agentMessage' && item.text === finalText);
    const scanner = (finalItem?.id ? scanners.get(finalItem.id) : undefined) ?? (scanners.size === 1 ? [...scanners.values()][0] : undefined) ?? new IntentBlockStream(args.pageNumber, onBlock, args.labelRules);
    const result = scanner!.finish(finalText);
    args.onActivity?.({ phase: 'complete', message: 'Final annotations are ready.' });
    return { pageNumber: args.pageNumber, sourcePageNumber: args.sourcePageNumber ?? args.pageNumber, ...result, model, provider: 'codex-app-server', generatedAt: new Date().toISOString(), usage };
  } catch (error) { args.signal?.throwIfAborted(); throw streamError ?? error; }
  finally { args.signal?.removeEventListener('abort', abort); client.close(); await rm(directory, { recursive: true, force: true }); }
}
