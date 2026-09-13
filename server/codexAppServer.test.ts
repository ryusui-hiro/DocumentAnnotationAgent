import assert from 'node:assert/strict';
import test from 'node:test';
import { annotationOutputSchema, readFinalAgentMessage, resolveCodexAppServerBinary } from './codexAppServer';

test('Codex App Server binary override takes precedence over automatic discovery', () => {
  assert.equal(resolveCodexAppServerBinary('  /custom/codex  ', 'darwin', () => true), '/custom/codex');
});

test('macOS prefers the bundled ChatGPT CLI, while other platforms use PATH', () => {
  assert.equal(
    resolveCodexAppServerBinary(undefined, 'darwin', (path) => path === '/Applications/ChatGPT.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  assert.equal(resolveCodexAppServerBinary(undefined, 'linux', () => true), 'codex');
});

function assertStrictObjectSchemas(schema: Record<string, unknown>, path = '$') {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} must reject additional properties`);
    const properties = schema.properties as Record<string, unknown>;
    const required = schema.required as string[];
    assert.deepEqual([...required].sort(), Object.keys(properties).sort(), `${path} must require every property`);
    for (const [key, child] of Object.entries(properties)) {
      assertStrictObjectSchemas(child as Record<string, unknown>, `${path}.${key}`);
    }
  }
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    assertStrictObjectSchemas(schema.items as Record<string, unknown>, `${path}[]`);
  }
}

test('Codex annotation output schema satisfies strict structured-output requirements', () => {
  assertStrictObjectSchemas(annotationOutputSchema);
});

test('uses a completed notification message without a history read', async () => {
  let readCount = 0;
  const text = await readFinalAgentMessage({
    async request() { readCount += 1; return {}; },
  }, 'thread-1', {
    turn: { id: 'turn-1', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', text: '{"annotations":[]}' }] },
  });
  assert.equal(text, '{"annotations":[]}');
  assert.equal(readCount, 0);
});

test('reads full turn history when the completion notification omits its agent message', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const text = await readFinalAgentMessage({
    async request(method, params) {
      calls.push({ method, params });
      return { thread: { turns: [
        { id: 'older-turn', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', text: 'old' }] },
        { id: 'turn-2', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', text: '{"annotations":[]}' }] },
      ] } };
    },
  }, 'thread-2', {
    turn: { id: 'turn-2', status: 'completed', itemsView: 'notLoaded', items: [] },
  });
  assert.equal(text, '{"annotations":[]}');
  assert.deepEqual(calls, [{ method: 'thread/read', params: { threadId: 'thread-2', includeTurns: true } }]);
});

test('reports turn metadata when neither completion nor history contains a final message', async () => {
  await assert.rejects(
    readFinalAgentMessage({
      async request() { return { thread: { turns: [] } }; },
    }, 'thread-3', {
      turn: { id: 'turn-3', status: 'failed', itemsView: 'summary', items: [{ type: 'reasoning' }] },
    }),
    /status=failed, error=none, itemsView=summary, itemTypes=reasoning/,
  );
});
