import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeAgentStream } from './agentStream';

function streamedResponse(chunks: string[], contentType = 'text/event-stream; charset=utf-8') {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': contentType } });
}

test('consumes fragmented SSE events, surfaces activity immediately, and returns the final payload', async () => {
  const activity: string[] = [];
  const response = streamedResponse([
    'event: act',
    'ivity\r\ndata: {"toolName":"delegate_page_reader","phase":"Reading","detail":"Reading page 1","status":"active","pageNumber":1}\r\n\r',
    '\nevent: activity\r\ndata: {"toolName":"navigate_page","phase":"Navigating","detail":"page 2","status":"complete","pageNumber":2}\r\n\r',
    '\nevent: result\r\ndata: {"status":"complete","visitedPages":[1,2]}\r\n\r\n',
    'event: done\r\ndata: {}\r\n\r\n',
  ]);
  const result = await consumeAgentStream<{ status: string; visitedPages: number[] }>(response, (event) => activity.push(`${event.toolName}:${event.pageNumber}:${event.status}`));
  assert.deepEqual(activity, ['delegate_page_reader:1:active', 'navigate_page:2:complete']);
  assert.equal(result.streamedActivityCount, 2);
  assert.deepEqual(result.payload, { status: 'complete', visitedPages: [1, 2] });
});

test('returns JSON responses for providers without SSE activity support', async () => {
  const result = await consumeAgentStream<{ annotations: number[] }>(
    streamedResponse(['{"annotations":[1,2]}'], 'application/json'),
    () => assert.fail('JSON fallback must not emit activity'),
  );
  assert.deepEqual(result.payload, { annotations: [1, 2] });
  assert.equal(result.streamedActivityCount, 0);
});

test('surfaces errors sent after the stream has started', async () => {
  const response = streamedResponse(['event: error\ndata: {"error":"The Agent Run expired."}\n\n']);
  await assert.rejects(consumeAgentStream(response, () => undefined), /Agent Run expired/);
});
