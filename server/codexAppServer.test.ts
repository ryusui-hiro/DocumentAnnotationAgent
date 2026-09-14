import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseTaskPlan, taskPlanJsonSchema } from '../src/taskPlan';
import { AppServerClient, annotationOutputSchema, codexWorkbookTurnJsonSchema, draftCorrectionRuleWithCodexAppServer, planTaskWithCodexAppServer, readCodexAppServerAuthStatus, readFinalAgentMessage, resolveCodexAppServerBinary } from './codexAppServer';
import { correctionRuleJsonSchema, parseCorrectionRuleDraft } from './correctionRulePlanner';

test('Codex App Server binary override takes precedence over automatic discovery', () => {
  assert.equal(resolveCodexAppServerBinary('  /custom/codex  ', 'darwin', () => true), '/custom/codex');
});

test('macOS prefers the bundled ChatGPT CLI, while other platforms use PATH', () => {
  assert.equal(
    resolveCodexAppServerBinary(undefined, 'darwin', (path) => path === '/Applications/ChatGPT.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  assert.equal(resolveCodexAppServerBinary(undefined, 'linux', () => true), 'codex');
  assert.equal(
    resolveCodexAppServerBinary(undefined, 'darwin', (path) => path === '/Applications/Codex.app/Contents/Resources/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  );
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

test('Codex workbook read/proposal turns export a strict bounded schema', () => {
  assertStrictObjectSchemas(codexWorkbookTurnJsonSchema as Record<string, unknown>);
  const properties = codexWorkbookTurnJsonSchema.properties as Record<string, unknown>;
  assert.deepEqual(properties.phase, { type: 'string', enum: ['read_ranges', 'propose_changes'] });
  assert.match(JSON.stringify(codexWorkbookTurnJsonSchema), /maximum|readRequests|changes/);
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

test('does not return an earlier turn when the completed turn is missing from history', async () => {
  await assert.rejects(readFinalAgentMessage({
    async request() { return { thread: { turns: [{ id: 'older-turn', status: 'completed', items: [{ type: 'agentMessage', text: '{"annotations":[]}' }] }] } }; },
  }, 'thread-1', { turn: { id: 'current-turn', status: 'completed', items: [] } }), /最終メッセージ/);
});

test('does not apply partial output from a failed or interrupted turn', async () => {
  for (const status of ['failed', 'interrupted']) {
    await assert.rejects(readFinalAgentMessage({ async request() { return {}; } }, 'thread-1', {
      turn: { id: 'turn-1', status, items: [{ type: 'agentMessage', text: '{"annotations":[]}' }] },
    }), new RegExp(`status=${status}`));
  }
});

async function withFakeAppServer(body: string, run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-codex-transport-test-'));
  const binaryPath = join(directory, 'fake-codex.cjs');
  const previousBinary = process.env.CODEX_APP_SERVER_BIN;
  await writeFile(binaryPath, `#!/usr/bin/env node
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
${body}
`, { mode: 0o755 });
  process.env.CODEX_APP_SERVER_BIN = binaryPath;
  try { await run(); }
  finally {
    if (previousBinary === undefined) delete process.env.CODEX_APP_SERVER_BIN;
    else process.env.CODEX_APP_SERVER_BIN = previousBinary;
    await rm(directory, { recursive: true, force: true });
  }
}

test('drains verbose App Server stderr so RPC cannot stall behind a full pipe', { timeout: 5000 }, async () => {
  await withFakeAppServer(`lines.on('line', (line) => {
    const request = JSON.parse(line);
    process.stderr.write('diagnostic '.repeat(100000), () => send({ id: request.id, result: { ok: true } }));
  });`, async () => {
    const client = new AppServerClient();
    try { assert.deepEqual(await client.request('probe', {}, 2000), { ok: true }); }
    finally { client.close(); }
  });
});

test('distinguishes server request IDs from pending client RPC IDs', { timeout: 5000 }, async () => {
  await withFakeAppServer(`lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'probe') send({ id: request.id, method: 'unsupported/approval', params: {} });
    else if (request.error?.code === -32601) send({ id: request.id, result: { ok: true } });
  });`, async () => {
    const client = new AppServerClient();
    try { assert.deepEqual(await client.request('probe', {}, 2000), { ok: true }); }
    finally { client.close(); }
  });
});

test('disconnect immediately rejects turn waiters and all later RPCs', { timeout: 5000 }, async () => {
  await withFakeAppServer(`lines.on('line', () => process.exit(7));`, async () => {
    const client = new AppServerClient();
    try {
      const completed = client.onceNotification('turn/completed', () => true);
      await assert.rejects(client.request('probe', {}, 2000), /終了|切断/);
      await assert.rejects(completed, /終了|切断/);
      await assert.rejects(client.request('after-exit', {}, 2000), /終了|切断/);
    } finally { client.close(); }
  });
});

test('failed turn startup closes its pre-registered completion waiter', { timeout: 5000 }, async () => {
  await withFakeAppServer(`lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
    if (request.method === 'turn/start') send({ id: request.id, error: { code: -32000, message: 'synthetic startup failure' } });
  });`, async () => {
    await assert.rejects(planTaskWithCodexAppServer({
      instruction: 'Find totals.', guidelines: '', correction: '', mode: 'assist', model: 'synthetic', reasoningEffort: 'low',
    }), /synthetic startup failure/);
  });
});

test('auth readiness requires sign-in when needed and returns no account details', { timeout: 5000 }, async () => {
  const fixtures = [
    { account: null, requiresOpenaiAuth: true },
    { account: { type: 'chatgpt', email: 'synthetic-private@example.test', planType: 'pro' }, requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: false },
    {},
  ];
  for (const [index, fixture] of fixtures.entries()) {
    await withFakeAppServer(`lines.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ id: request.id, result: {} });
      if (request.method === 'account/read') send({ id: request.id, result: ${JSON.stringify(fixture)} });
    });`, async () => {
      assert.deepEqual(await readCodexAppServerAuthStatus(), { ready: index === 1 || index === 2 });
    });
  }
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

test('Codex correction-rule planner uses a read-only thread and the same strict proposal schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-codex-rule-planner-test-'));
  const binaryPath = join(directory, 'fake-codex-app-server.js');
  const capturePath = join(directory, 'turn-start.json');
  const previousBinary = process.env.CODEX_APP_SERVER_BIN;
  const previousCapture = process.env.CODEX_APP_SERVER_CAPTURE;
  const draft = {
    outcome: 'proposed_rule',
    rule: 'Label a visible email address as EMAIL.',
    basis: 'The task and guideline explicitly identify email addresses.',
    reason: null,
  };
  const fakeServer = `#!/usr/bin/env node
const readline = require('node:readline');
const { writeFileSync } = require('node:fs');
const draft = ${JSON.stringify(draft)};
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'rule-thread' } } });
  if (request.method === 'turn/start') {
    writeFileSync(process.env.CODEX_APP_SERVER_CAPTURE, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: 'rule-turn', status: 'inProgress', items: [] } } });
    send({ method: 'turn/completed', params: { threadId: 'rule-thread', turn: { id: 'rule-turn', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(draft) }] } } });
  }
});
`;
  try {
    await writeFile(binaryPath, fakeServer, { mode: 0o755 });
    await chmod(binaryPath, 0o755);
    process.env.CODEX_APP_SERVER_BIN = binaryPath;
    process.env.CODEX_APP_SERVER_CAPTURE = capturePath;

    const result = await draftCorrectionRuleWithCodexAppServer({
      model: 'local-test-model', reasoningEffort: 'low',
      input: {
        task: 'Find visible email addresses.', taskPlan: 'Label complete addresses EMAIL.', guidelines: 'Only use EMAIL for a visible address.',
        sourceCandidate: { pageNumber: 2, label: 'CONTACT', note: 'May be an email.', reason: 'It contains an at-sign.', excerpt: 'alex@example.test' },
        correction: { label: 'EMAIL', note: 'This is a visible email address.' },
      },
    });

    assert.deepEqual(parseCorrectionRuleDraft(JSON.parse(result.outputText)), {
      outcome: 'proposed_rule', rule: draft.rule, basis: draft.basis,
    });
    const turnStart = JSON.parse(await readFile(capturePath, 'utf8')) as { outputSchema?: unknown; model?: string; input?: Array<{ text?: string }> };
    assert.equal(turnStart.model, 'local-test-model');
    assert.deepEqual(turnStart.outputSchema, correctionRuleJsonSchema);
    assert.match(turnStart.input?.[0]?.text ?? '', /alex@example\.test/);
    assert.match(turnStart.input?.[0]?.text ?? '', /A proposal is not an active rule/);
  } finally {
    if (previousBinary === undefined) delete process.env.CODEX_APP_SERVER_BIN;
    else process.env.CODEX_APP_SERVER_BIN = previousBinary;
    if (previousCapture === undefined) delete process.env.CODEX_APP_SERVER_CAPTURE;
    else process.env.CODEX_APP_SERVER_CAPTURE = previousCapture;
    await rm(directory, { recursive: true, force: true });
  }
});
