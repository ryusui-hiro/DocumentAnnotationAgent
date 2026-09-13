import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseTaskPlan, taskPlanJsonSchema } from '../src/taskPlan';
import { annotationOutputSchema, planTaskWithCodexAppServer, readFinalAgentMessage, resolveCodexAppServerBinary } from './codexAppServer';

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

const validPlan = {
  title: 'PII review',
  objective: 'Find and label personal data.',
  labels: [{ name: 'EMAIL', description: 'Email addresses' }],
  actions: ['Highlight each match', 'Attach an evidence excerpt'],
  uncertaintyPolicy: 'Ask a human when text is unreadable.',
  workflow: ['Read each page.', 'Mark matches.', 'Queue uncertain cases.'],
};

test('Codex task planner sends its bounded schema and reads the final App Server message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-codex-planner-test-'));
  const binaryPath = join(directory, 'fake-codex-app-server.js');
  const capturePath = join(directory, 'turn-start.json');
  const previousBinary = process.env.CODEX_APP_SERVER_BIN;
  const previousCapture = process.env.CODEX_APP_SERVER_CAPTURE;
  const fakeServer = `#!/usr/bin/env node
const readline = require('node:readline');
const { writeFileSync } = require('node:fs');
const plan = ${JSON.stringify(validPlan)};
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'test-thread' } } });
  if (request.method === 'turn/start') {
    writeFileSync(process.env.CODEX_APP_SERVER_CAPTURE, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: 'test-turn', status: 'inProgress', items: [] } } });
    send({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(plan) }] } } });
  }
});
`;
  try {
    await writeFile(binaryPath, fakeServer, { mode: 0o755 });
    await chmod(binaryPath, 0o755);
    process.env.CODEX_APP_SERVER_BIN = binaryPath;
    process.env.CODEX_APP_SERVER_CAPTURE = capturePath;

    const result = await planTaskWithCodexAppServer({
      instruction: 'Find email addresses.',
      guidelines: 'Label them EMAIL.',
      correction: '',
      mode: 'assist',
      model: 'local-test-model',
      reasoningEffort: 'low',
    });

    assert.deepEqual(parseTaskPlan(JSON.parse(result.outputText)), validPlan);
    const turnStart = JSON.parse(await readFile(capturePath, 'utf8')) as { outputSchema?: unknown; model?: string };
    assert.equal(turnStart.model, 'local-test-model');
    assert.deepEqual(turnStart.outputSchema, taskPlanJsonSchema);
  } finally {
    if (previousBinary === undefined) delete process.env.CODEX_APP_SERVER_BIN;
    else process.env.CODEX_APP_SERVER_BIN = previousBinary;
    if (previousCapture === undefined) delete process.env.CODEX_APP_SERVER_CAPTURE;
    else process.env.CODEX_APP_SERVER_CAPTURE = previousCapture;
    await rm(directory, { recursive: true, force: true });
  }
});
