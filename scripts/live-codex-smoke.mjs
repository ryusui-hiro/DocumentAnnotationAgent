import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { AppServerClient, annotateWithCodexAppServer, listCodexModels, planTaskWithCodexAppServer, resolveCodexAppServerBinary } from '../server/codexAppServer.ts';
import { parseTaskPlan } from '../src/taskPlan.ts';

if (process.env.ANNOTATION_STUDIO_LIVE_SMOKE !== '1') {
  throw new Error('This test uses the signed-in Codex account and consumes model usage. Set ANNOTATION_STUDIO_LIVE_SMOKE=1 to run intentionally.');
}

const model = 'gpt-6-astra';
const client = new AppServerClient();
let authMode;
try {
  await client.initialize();
  const account = await client.request('account/read', { refreshToken: false });
  authMode = account.account?.type ?? null;
  assert.ok(authMode || account.requiresOpenaiAuth === false, 'Sign in with codex login before running the Codex smoke test.');
} finally { client.close(); }

const models = await listCodexModels();
const selectedModel = models.find((item) => item.model === model || item.id === model);
assert.ok(selectedModel, 'The signed-in Codex model catalog must offer gpt-6-astra.');
assert.ok(selectedModel.inputModalities.includes('image'), 'gpt-6-astra must support images.');

const instruction = 'この合成請求書に明記された請求総額の行だけを矩形で囲み、ラベルを「総額」にしてください。テキスト注釈と引用に金額を含めてください。商品価格やメールアドレスには注釈を付けないでください。';
const startedAt = Date.now();
process.stdout.write('Codex GPT-6 Astra: authenticated model catalog confirmed; planning synthetic invoice annotation.\n');
const planned = await planTaskWithCodexAppServer({
  instruction, guidelines: '原文で確認できる請求総額だけに「総額」を付ける。', correction: '', mode: 'assist', model, reasoningEffort: 'low',
});
const plan = parseTaskPlan(JSON.parse(planned.outputText));
assert.ok(plan, 'Planner output must match the executable task plan schema.');
assert.ok(plan.labels.some((label) => label.name === '総額'), 'Planner must preserve the requested label.');

// A deterministic, fictional page. No user documents or personal data are read.
const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800">
  <rect width="1000" height="800" fill="white"/>
  <g font-family="Arial, sans-serif" fill="#202020">
    <text x="80" y="110" font-size="34" font-weight="bold">SYNTHETIC INVOICE</text>
    <text x="80" y="190" font-size="24">Document fixture — no real customer data</text>
    <text x="80" y="270" font-size="28">Item A: JPY 100,000</text>
    <text x="80" y="320" font-size="28">Delivery: JPY 28,000</text>
    <text x="80" y="420" font-size="40" font-weight="bold">TOTAL DUE: JPY 128,000</text>
    <text x="80" y="550" font-size="24">Contact: example@example.test</text>
  </g>
</svg>`)).png().toBuffer();
process.stdout.write('Codex GPT-6 Astra: structured plan received; inspecting the synthetic page image.\n');
const result = await annotateWithCodexAppServer({ instruction, imageDataUrl: `data:image/png;base64,${png.toString('base64')}`, model, reasoningEffort: 'low' });
const parsed = JSON.parse(result.outputText);
assert.ok(Array.isArray(parsed.annotations), 'Visual result must contain annotations.');
assert.equal(parsed.annotations.length, 1, 'The task asks for exactly the total row.');
const annotation = parsed.annotations[0];
assert.equal(annotation.label, '総額', 'The requested annotation label must be preserved.');
assert.match(`${annotation.note} ${annotation.excerpt}`.replaceAll(',', ''), /128000/, 'The annotation must cite the visible total.');
for (const coordinate of ['x', 'y', 'width', 'height']) {
  assert.ok(Number.isFinite(annotation[coordinate]) && annotation[coordinate] >= 0 && annotation[coordinate] <= 1, `${coordinate} must be normalized.`);
}
assert.ok(annotation.width > 0 && annotation.height > 0 && annotation.x + annotation.width <= 1 && annotation.y + annotation.height <= 1, 'Annotation must lie within the page.');
assert.ok(annotation.y < 0.525 && annotation.y + annotation.height > 0.48, 'Annotation must overlap the known total text row.');
assert.ok(annotation.x < 0.5 && annotation.x + annotation.width > 0.3, 'Annotation must overlap the total text horizontally.');

const directory = resolve('output/live-codex-smoke');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'synthetic-invoice.png'), png);
await writeFile(resolve(directory, 'result.json'), `${JSON.stringify({
  checkedAt: new Date().toISOString(), provider: 'codex-app-server', model, authMode,
  binary: resolveCodexAppServerBinary(), elapsedMs: Date.now() - startedAt,
  checks: ['authenticated-catalog', 'image-modality', 'strict-task-plan', 'requested-label', 'visible-evidence', 'normalized-region'],
  plan, annotations: parsed.annotations, usage: { planner: planned.usage, annotator: result.usage },
}, null, 2)}\n`);
process.stdout.write(`Live Codex smoke passed: ${model}; structured planning, synthetic image annotation, requested label, visible amount, and normalized bounds. Evidence: ${directory}/result.json\n`);
