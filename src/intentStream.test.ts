import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeIntentStream, validatedIntentBlock } from './intentStream';
import type { PaperBlock, PaperPageResult } from './paperOcrTypes';

const block: PaperBlock = { id: 'intent-p1-b1', type: 'region', label: 'Payment deadline', note: 'Check the payment date.', bbox: { x: .1, y: .2, width: .4, height: .1 }, extractedText: '支払期限: 30 September 2026', latex: null, uncertain: false, uncertaintyReason: '' };
const result: PaperPageResult = { pageNumber: 1, sourcePageNumber: 7, blocks: [block], warnings: [], model: 'gpt-6-astra', provider: 'codex-app-server', generatedAt: '2026-09-14T00:00:00Z' };
const frame = (event: string, value: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
function response(chunks: string[]) {
  return new Response(new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('emits each validated annotation before the final result arrives, including fragmented UTF-8', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const observed: PaperBlock[] = [];
  const activity: string[] = [];
  let blockObserved!: () => void;
  const firstBlock = new Promise<void>((resolve) => { blockObserved = resolve; });
  let completed = false;
  const running = consumeIntentStream(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), {
    pageNumber: 1,
    onStart: (value) => activity.push(String(value.provider)),
    onActivity: (value) => activity.push(value.message),
    onBlock: (value) => { observed.push(value); blockObserved(); },
  }).then((value) => { completed = true; return value; });
  const first = new TextEncoder().encode(frame('start', { pageNumber: 1, provider: 'codex-app-server' }) + frame('activity', { pageNumber: 1, phase: 'Reading', message: 'Reading the supplied page.' }) + frame('block', { pageNumber: 1, block }));
  for (let offset = 0; offset < first.length; offset += 3) controller.enqueue(first.slice(offset, offset + 3));
  await firstBlock;
  assert.equal(completed, false, 'annotation arrives while the actual response is still open');
  assert.equal(observed[0]?.extractedText, block.extractedText, 'the original multilingual text is preserved');
  assert.deepEqual(activity, ['codex-app-server', 'Reading the supplied page.']);
  controller.enqueue(new TextEncoder().encode(frame('complete', result))); controller.close();
  assert.equal((await running).status, 'complete');
});

test('never treats a truncated or failed response as complete after streamed proposals', async () => {
  for (const ending of ['', frame('error', { pageNumber: 1, error: 'Provider disconnected.' })]) {
    const blocks: PaperBlock[] = [];
    await assert.rejects(consumeIntentStream(response([frame('block', { pageNumber: 1, block }), ending]), { pageNumber: 1, onActivity() {}, onBlock(value) { blocks.push(value); } }), /before the AI completed|Provider disconnected/);
    assert.equal(blocks.length, 1, 'the UI can retain the partial result as unconfirmed evidence');
  }
});

test('rejects cross-page events and invalid model geometry before surfacing a block', async () => {
  await assert.rejects(consumeIntentStream(response([frame('block', { pageNumber: 2, block })]), { pageNumber: 1, onActivity() {}, onBlock() { assert.fail('cross-page block was applied'); } }), /different page/);
  assert.throws(() => validatedIntentBlock({ ...block, bbox: { x: .9, y: .2, width: .4, height: .1 } }), /outside the page/);
  assert.throws(() => validatedIntentBlock({ ...block, bbox: { x: 1, y: .2, width: .0000001, height: .1 } }), /outside the page/);
  await assert.rejects(consumeIntentStream(response([frame('complete', { ...result, blocks: [block, block] })]), { pageNumber: 1, onActivity() {}, onBlock() {} }), /duplicate annotation IDs/);
});

test('human-defined names constrain both incremental blocks and the final result exactly', async () => {
  const labelRules = [{ name: 'Payment deadline', description: 'Only the date by which payment must arrive.' }];
  await assert.rejects(consumeIntentStream(response([frame('block', { pageNumber: 1, block: { ...block, label: 'payment deadline' } })]), {
    pageNumber: 1, labelRules, onActivity() {}, onBlock() { assert.fail('an unrequested label reached the UI'); },
  }), /outside your defined labels/);
  let received = 0;
  await assert.rejects(consumeIntentStream(response([frame('block', { pageNumber: 1, block }), frame('complete', { ...result, blocks: [{ ...block, label: 'Other' }] })]), {
    pageNumber: 1, labelRules, onActivity() {}, onBlock() { received++; },
  }), /outside your defined labels/);
  assert.equal(received, 1, 'a valid provisional result is still visible while the invalid final set is rejected');
});

test('malformed or empty HTTP responses surface actionable connection errors', async () => {
  const callbacks = { pageNumber: 1, onActivity() {}, onBlock() { assert.fail('an incomplete block must not be applied'); } };
  await assert.rejects(consumeIntentStream(response(['event: block\ndata: {"block":']), callbacks), (error: unknown) => error instanceof Error && !(error instanceof SyntaxError) && error.message.includes('interrupted or malformed'));
  await assert.rejects(consumeIntentStream(new Response('', { status: 502 }), callbacks), /empty response.*HTTP 502/);
});
