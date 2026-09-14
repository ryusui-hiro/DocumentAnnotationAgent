import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ScriptedModel, assistantMessage, functionCall, modelResponder, modelResponse, type RecordedModelCall, type ScriptedModelInput } from '@openai/agents/testing';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { configureDocumentExportStoreForTests, configurePendingAgentRunStoreForTests, getPendingAgentRunInfo, isExplicitExportRequest, pendingAgentRunMatchesProviderIdentity, restorePendingAgentRun, resumeDocumentAgentRun, runDocumentAgent } from './documentAgent';
import { SpreadsheetDocumentAdapter } from './spreadsheetAdapter';
import { PagedDocumentAdapter } from './documentAdapter';
import { createPrivateRecordStore } from './privateRecordStore';
import { createDocumentExportStore } from './documentExportStore';
import { documentAnnotatorLimits } from './documentAnnotator';
import type { PreviewReport } from 'document-svg';

let persistenceDirectory = '';
let pendingRunStore: ReturnType<typeof createPrivateRecordStore>;
let agentExportStore: ReturnType<typeof createDocumentExportStore>;

function inputTextFromModelCall(call: { request: { input: unknown } }) {
  const messages = call.request.input;
  assert.ok(Array.isArray(messages));
  const message = messages.find((item) => item && typeof item === 'object' && 'content' in item) as { content?: unknown } | undefined;
  assert.ok(message && Array.isArray(message.content));
  const text = message.content.find((item) => item && typeof item === 'object' && 'text' in item) as { text?: unknown } | undefined;
  assert.ok(text && typeof text.text === 'string');
  return text.text;
}

function readToolResult(call: RecordedModelCall, toolName: string): Record<string, unknown> {
  const item = Array.isArray(call.request.input)
    ? [...call.request.input].reverse().find((entry) => entry.type === 'function_call_result' && entry.name === toolName)
    : undefined;
  assert.ok(item, `the ${toolName} tool result is returned to the Agent`);
  const rawOutput = 'output' in item ? item.output : undefined;
  const outputText = typeof rawOutput === 'string' ? rawOutput
    : rawOutput && !Array.isArray(rawOutput) && typeof rawOutput === 'object' && 'text' in rawOutput ? String(rawOutput.text)
      : '';
  assert.ok(outputText, `${toolName} returns a JSON text result`);
  return JSON.parse(outputText) as Record<string, unknown>;
}

before(async () => {
  persistenceDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-agent-tests-'));
  pendingRunStore = createPrivateRecordStore(persistenceDirectory);
  configurePendingAgentRunStoreForTests(pendingRunStore);
  agentExportStore = createDocumentExportStore(pendingRunStore);
  configureDocumentExportStoreForTests(agentExportStore);
});
after(async () => {
  if (persistenceDirectory) await rm(persistenceDirectory, { recursive: true, force: true });
});

test('the document agent pauses on review and resumes the same RunState after approval', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'outline-1' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'inspect-1' })]),
    modelResponse([functionCall('search_page_text', { query: 'termination' }, { callId: 'search-1' })]),
    modelResponse([functionCall('annotate_region', {
        x: 0.1, y: 0.2, width: 0.35, height: 0.08,
        label: 'Termination clause', note: 'Either party may terminate after notice.',
        reason: 'The clause grants a clear termination right.', excerpt: 'Either party may terminate',
        confidence: 0.01, reviewPriority: 'low', requiresReview: false,
      }, { callId: 'annotate-1' })]),
    modelResponse([functionCall('request_review', {
        x: 0.1, y: 0.4, width: 0.4, height: 0.1,
        label: 'Conditional termination', note: 'Termination depends on a vague condition.',
        reason: 'The trigger is not defined in the document.', excerpt: 'reasonable circumstances',
        confidence: 0.61, reviewPriority: 'high', requiresReview: true,
      }, { callId: 'review-1' })]),
    modelResponse([assistantMessage('Page inspected. One region is clear and one needs review.')]),
  ]);

  const liveActivity: string[] = [];
  const result = await runDocumentAgent({
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instruction: 'Find and classify termination clauses.',
    guidelines: 'Mark clear termination rights and ask about ambiguous conditions.',
    correction: '',
    humanDecisions: '',
    pageText: '[x=0.100, y=0.200] Either party may terminate after notice.',
    imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1,
    totalPages: 2,
    mode: 'assist',
    onToolEvent: (event) => liveActivity.push(event.toolName),
  }, model);

  assert.equal(result.status, 'interrupted');
  assert.ok(result.approvalRunId);
  assert.ok(result.approvalId);
  assert.equal(result.annotations.length, 2);
  assert.equal(result.annotations[0].requiresReview, false);
  assert.equal(result.annotations[0].confidence, 0.01);
  assert.equal(result.annotations[1].requiresReview, true);
  assert.notEqual(result.annotations[1].approvalId, undefined);
  assert.equal(result.annotations[1].reviewedByHuman, undefined);
  assert.equal(result.annotations[1].approvalRunId, result.approvalRunId);
  assert.deepEqual(result.toolEvents.map((event) => event.toolName), [
    'get_document_outline',
    'inspect_page',
    'search_page_text',
    'annotate_region',
    'request_review',
  ]);
  assert.equal(result.toolEvents.at(-1)?.phase, 'Asking');
  assert.deepEqual(liveActivity, result.toolEvents.map((event) => event.toolName));

  const resumedActivity: string[] = [];
  const resumed = await resumeDocumentAgentRun({ runId: result.approvalRunId!, approvalId: result.approvalId!, approved: true, onToolEvent: (event) => resumedActivity.push(event.toolName) });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.toolEvents.at(-1)?.toolName, 'annotate_region');
  assert.equal(resumed.toolEvents.at(-1)?.status, 'complete');
  assert.deepEqual(resumedActivity, resumed.toolEvents.map((event) => event.toolName));
});

test('Assist holds high review priority regardless of the optional numeric estimate', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'priority-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'priority-inspect' })]),
    modelResponse([functionCall('annotate_region', {
      x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: 'Possible issue', note: 'Needs careful review.',
      reason: 'The exception is unusually broad.', confidence: 0.99, reviewPriority: 'high', requiresReview: false,
    }, { callId: 'priority-annotate' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: 'Possible issue', note: 'Needs careful review.',
      reason: 'The exception is unusually broad.', confidence: 0.99, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'priority-review' })]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find important exceptions.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'A broad exception.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
  }, model);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0]?.requiresReview, true);
  assert.equal(result.annotations[0]?.reviewPriority, 'high');
  model.assertComplete();
});

test('Autopilot applies clear high-priority findings and reports them without pausing', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'autopilot-high-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'autopilot-high-inspect' })]),
    modelResponse([functionCall('annotate_region', {
      x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: 'HIGH RISK', note: 'Unilateral termination right.',
      reason: 'The text clearly grants either party termination without cause.', excerpt: 'Either party may terminate without cause.',
      confidence: 0.01, reviewPriority: 'high', requiresReview: false,
    }, { callId: 'autopilot-high-annotation' })]),
    modelResponse([assistantMessage('I applied the clear high-priority finding and will report it.')]),
  ]);
  const adapter = new PagedDocumentAdapter('agreement.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Either party may terminate without cause.</text></svg>' }],
  } as unknown as PreviewReport, 'autopilot-high-doc');
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find and classify termination clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Either party may terminate without cause.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'autopilot',
    documentId: 'autopilot-high-doc', documentAdapters: [adapter],
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations[0]?.requiresReview, false);
  assert.equal(result.annotations[0]?.reviewPriority, 'high');
  assert.equal(adapter.listAnnotations()[0]?.status, 'auto');
  assert.match(result.toolEvents.find((event) => event.toolName === 'annotate_region')?.detail ?? '', /Autopilot will report this important finding/);
});

test('Autopilot still pauses for evidence that explicitly needs human judgment', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'autopilot-uncertain-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'autopilot-uncertain-inspect' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: 'UNCERTAIN', note: 'The exception is unclear.',
      reason: 'The termination condition is not defined in the document.', excerpt: 'reasonable circumstances',
      confidence: null, reviewPriority: 'medium', requiresReview: true,
    }, { callId: 'autopilot-uncertain-review' })]),
    modelResponse([assistantMessage('I am waiting only on the unclear clause.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find termination clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'The document gives no definition.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'autopilot',
  }, model);

  assert.equal(result.status, 'interrupted');
  assert.equal(result.annotations[0]?.requiresReview, true);
  assert.equal(result.annotations[0]?.reviewPriority, 'medium');
  const resumed = await resumeDocumentAgentRun({ runId: result.approvalRunId!, approvalId: result.approvalId!, approved: true });
  assert.equal(resumed.status, 'complete');
  assert.ok(resumed.toolEvents.some((event) => event.toolName === 'annotate_region' && event.status === 'complete'));
  model.assertComplete();
});

test('observe and suggest modes use non-applying tools', async () => {
  for (const mode of ['observe', 'suggest'] as const) {
    const toolName = mode === 'observe' ? 'report_finding' : 'suggest_annotation';
    const model = new ScriptedModel([
      modelResponse([functionCall('get_document_outline', {}, { callId: `${mode}-outline` })]),
      modelResponse([functionCall('inspect_page', {}, { callId: `${mode}-inspect` })]),
      modelResponse([functionCall(toolName, {
        x: 0.2, y: 0.25, width: 0.4, height: 0.1,
        label: 'Evidence', note: 'A visible evidence block.', reason: 'The text supports the task.',
        confidence: 0.93, reviewPriority: 'medium', requiresReview: false,
      }, { callId: `${mode}-finding` })]),
      modelResponse([assistantMessage(`${mode} run complete.`)]),
    ]);
    const result = await runDocumentAgent({
      model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find evidence.',
      guidelines: '', correction: '', humanDecisions: '', pageText: 'Evidence text.',
      imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode,
    }, model);
    model.assertComplete();
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].requiresReview, mode === 'suggest');
    assert.equal(result.toolEvents.at(-1)?.toolName, toolName);
  }
});

test('select_text and annotate_text map a unique positioned phrase to a read-only finding', async () => {
  const adapter = new PagedDocumentAdapter('manual.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg><text>placeholder</text></svg>' }],
  } as unknown as PreviewReport, 'text-document');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'text-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'text-inspect' })]),
    modelResponse([functionCall('select_text', { text: 'power supply before servicing' }, { callId: 'text-select' })]),
    modelResponse([functionCall('annotate_text', {
      text: 'power supply before servicing', label: 'SAFETY WARNING', note: 'Disconnect power before servicing.',
      reason: 'The sentence states a safety precaution.', confidence: null, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'text-annotate' })]),
    modelResponse([assistantMessage('Two safety actions are visible in this region.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Find safety warnings.',
    guidelines: '', correction: '', humanDecisions: '',
    pageText: '[x=0.100, y=0.100, w=0.300, h=0.030] Disconnect the power supply\n[x=0.100, y=0.140, w=0.350, h=0.030] before servicing the fan.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'observe', documentId: 'text-document', documentAdapters: [adapter],
  }, model);

  model.assertComplete();
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0]?.label, 'SAFETY WARNING');
  assert.deepEqual({ x: result.annotations[0]?.x, y: result.annotations[0]?.y, width: result.annotations[0]?.width, height: result.annotations[0]?.height }, {
    x: 0.1, y: 0.1, width: 0.30000000000000004, height: 0.07,
  });
  assert.equal(result.annotations[0]?.fragments?.length, 2);
  assert.equal(result.annotations[0]?.textAnchor?.quote.exact, 'power supply before servicing');
  assert.match(result.annotations[0]?.excerpt ?? '', /power supply before servicing/);
  assert.equal(result.annotations[0]?.requiresReview, true);
  assert.deepEqual(adapter.listAnnotations(), [], 'Observe findings must not enter the document annotation adapter');
  assert.deepEqual(result.toolEvents.slice(-2).map((event) => event.toolName), ['select_text', 'annotate_text']);
});

test('get_selected_region returns the viewer-selected annotation location to the Agent', async () => {
  const selected = { id: 'viewer-region', pageNumber: 2, x: 0.2, y: 0.3, width: 0.25, height: 0.05, label: 'HIGH RISK', note: 'Manual reviewer selection.', excerpt: 'Either party may terminate.', reviewPriority: 'high' as const, status: 'active' as const };
  const model = new ScriptedModel([
    modelResponder((call) => {
      const initialContext = JSON.stringify(call.request.input);
      assert.match(initialContext, /USER-SELECTED VIEWER ANNOTATION/);
      assert.match(initialContext, /x=0\.200, y=0\.300, width=0\.250, height=0\.050/);
      return [functionCall('get_document_outline', {}, { callId: 'selected-outline' })];
    }),
    modelResponse([functionCall('inspect_page', {}, { callId: 'selected-inspect' })]),
    modelResponse([functionCall('get_selected_region', {}, { callId: 'selected-region-read' })]),
    modelResponder((call) => {
      const outputItem = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'get_selected_region')
        : undefined;
      assert.ok(outputItem, 'the selected-region tool result is returned to the model');
      const rawOutput = 'output' in outputItem ? outputItem.output : undefined;
      const outputText = typeof rawOutput === 'string' ? rawOutput
        : rawOutput && !Array.isArray(rawOutput) && typeof rawOutput === 'object' && 'text' in rawOutput ? String(rawOutput.text)
          : '';
      assert.deepEqual(JSON.parse(outputText), {
        selected: true,
        source: 'viewer_annotation',
        userSelected: true,
        annotationId: 'viewer-region',
        pageNumber: 2,
        boundingBox: { x: 0.2, y: 0.3, width: 0.25, height: 0.05 },
        label: 'HIGH RISK',
        note: 'Manual reviewer selection.',
        excerpt: 'Either party may terminate.',
        reviewPriority: 'high',
        status: 'active',
      });
      return [assistantMessage('The selected high-risk region is on page 2.')];
    }),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Review the selected clause.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Current page text.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 2, totalPages: 2, mode: 'observe',
    existingAnnotations: [selected], selectedAnnotationId: selected.id,
    viewerAspectRatio: 1.5, viewerViewport: { x: 0.2, y: 0.3, width: 0.25, height: 0.05 },
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations.length, 0, 'reading a selected region stays read-only');
  assert.equal(result.toolEvents.find((event) => event.toolName === 'get_selected_region')?.pageNumber, 2);
});

test('scroll_document continues from the user-visible region instead of resetting to the page origin', async () => {
  const adapter = new PagedDocumentAdapter('viewer-context.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{
      number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><rect width="120" height="160" fill="white"/></svg>',
    }],
  } as unknown as PreviewReport, 'viewer-context');
  const viewport = { x: 0.2, y: 0.3, width: 0.35, height: 0.4 };
  const model = new ScriptedModel([
    modelResponder((call) => {
      const initialContext = JSON.stringify(call.request.input);
      assert.match(initialContext, /USER-SELECTED VIEWER ANNOTATION/);
      assert.match(initialContext, /Current human-visible page bounds .*x=0\.200, y=0\.300, width=0\.350, height=0\.400/);
      return [functionCall('get_document_outline', {}, { callId: 'viewer-context-outline' })];
    }),
    modelResponse([functionCall('inspect_page', {}, { callId: 'viewer-context-inspect' })]),
    modelResponse([functionCall('get_selected_region', {}, { callId: 'viewer-context-selected' })]),
    modelResponse([functionCall('scroll_document', { direction: 'down', amount: 0.1 }, { callId: 'viewer-context-scroll' })]),
    modelResponder((call) => {
      const output = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'scroll_document')
        : undefined;
      assert.ok(output, 'the viewer-relative crop returns to the Agent');
      const raw = 'output' in output ? output.output : undefined;
      assert.ok(Array.isArray(raw));
      const text = raw.find((item) => typeof item === 'object' && item.type === 'input_text');
      assert.ok(text && 'text' in text && typeof text.text === 'string');
      const result = JSON.parse(text.text) as { viewport: typeof viewport };
      assert.deepEqual(result.viewport, { ...viewport, y: 0.4 });
      return [assistantMessage('The crop starts from the human-visible part of the page.')];
    }),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Review the selected contract section.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Full page text.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'observe',
    documentAdapters: [adapter], selectedAnnotationId: 'viewer-selected',
    viewerAspectRatio: 1.5, viewerViewport: viewport,
    existingAnnotations: [{ id: 'viewer-selected', pageNumber: 1, ...viewport, label: 'HIGH RISK', note: 'Clause selected by the reviewer.', status: 'active' }],
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.toolEvents.find((event) => event.toolName === 'scroll_document')?.viewport?.y, 0.4);
});

test('scroll_document zooms into a detail crop when the human was viewing the full page', async () => {
  const adapter = new PagedDocumentAdapter('full-page-view.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{
      number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><rect width="120" height="160" fill="white"/></svg>',
    }],
  } as unknown as PreviewReport, 'full-page-view');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'full-view-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'full-view-inspect' })]),
    modelResponse([functionCall('scroll_document', { direction: 'down', amount: 0.1 }, { callId: 'full-view-scroll' })]),
    modelResponder((call) => {
      const output = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'scroll_document')
        : undefined;
      assert.ok(output);
      const raw = 'output' in output ? output.output : undefined;
      assert.ok(Array.isArray(raw));
      const text = raw.find((item) => typeof item === 'object' && item.type === 'input_text');
      assert.ok(text && 'text' in text && typeof text.text === 'string');
      const result = JSON.parse(text.text) as { moved: boolean; viewport: { x: number; y: number; width: number; height: number } };
      assert.equal(result.moved, true);
      assert.ok(Math.abs(result.viewport.x - 0.16) < 1e-9);
      assert.ok(Math.abs(result.viewport.y - 0.43) < 1e-9);
      assert.ok(Math.abs(result.viewport.width - 0.68) < 1e-9);
      assert.ok(Math.abs(result.viewport.height - 0.34) < 1e-9);
      return [assistantMessage('The first scroll opened a centered detail crop.')];
    }),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect this page for small details.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Full page text.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'observe',
    documentAdapters: [adapter], viewerAspectRatio: 1.5,
    viewerViewport: { x: 0, y: 0, width: 1, height: 1 },
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.toolEvents.find((event) => event.toolName === 'scroll_document')?.status, 'complete');
});

test('get_selected_region returns the unique text region selected by select_text', async () => {
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /No viewer annotation is selected by the user/);
      return [functionCall('get_document_outline', {}, { callId: 'text-region-outline' })];
    }),
    modelResponse([functionCall('inspect_page', {}, { callId: 'text-region-inspect' })]),
    modelResponse([functionCall('select_text', { text: '12 N-m' }, { callId: 'text-region-select' })]),
    modelResponse([functionCall('get_selected_region', {}, { callId: 'text-region-read' })]),
    modelResponder((call) => {
      const output = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'get_selected_region')
        : undefined;
      assert.ok(output);
      const rawOutput = 'output' in output ? output.output : undefined;
      const outputText = typeof rawOutput === 'string' ? rawOutput
        : rawOutput && !Array.isArray(rawOutput) && typeof rawOutput === 'object' && 'text' in rawOutput ? String(rawOutput.text)
          : '';
      const selected = JSON.parse(outputText) as { selected: boolean; source: string; excerpt: string };
      assert.equal(selected.selected, true);
      assert.equal(selected.source, 'positioned_text');
      assert.equal(selected.excerpt, '12 N-m');
      return [assistantMessage('The unique selected text region is ready for annotation.')];
    }),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect this selected phrase.',
    guidelines: '', correction: '', humanDecisions: '', pageText: '[x=0.100, y=0.200, w=0.300, h=0.030] Torque: 12 N-m.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'get_selected_region').length, 1);
});

test('scroll_document moves a bounded viewport and returns the cropped page image', async () => {
  const adapter = new PagedDocumentAdapter('scroll.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{
      number: 1, widthPoints: 120, heightPoints: 1200, warningCount: 0, warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="1200" viewBox="0 0 120 1200"><rect width="120" height="1200" fill="white"/><text x="8" y="20" font-size="10">Top of the page</text><text x="8" y="1190" font-size="10">Bottom of the page</text></svg>',
    }],
  } as unknown as PreviewReport, 'scroll-document');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'scroll-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'scroll-inspect' })]),
    modelResponse([functionCall('scroll_document', { direction: 'down', amount: 0.2 }, { callId: 'scroll-down' })]),
    modelResponder((call) => {
      const resultItem = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'scroll_document')
        : undefined;
      assert.ok(resultItem, 'the scroll result is returned to the model');
      const rawOutput = 'output' in resultItem ? resultItem.output : undefined;
      assert.ok(Array.isArray(rawOutput), 'the scroll result contains text and image content');
      const textOutput = rawOutput.find((item) => typeof item === 'object' && item.type === 'input_text');
      const imageOutput = rawOutput.find((item) => typeof item === 'object' && item.type === 'input_image');
      assert.ok(textOutput && 'text' in textOutput && typeof textOutput.text === 'string');
      assert.ok(imageOutput && 'image' in imageOutput && typeof imageOutput.image === 'string');
      const state = JSON.parse(textOutput.text) as { moved: boolean; reachedBoundary: boolean; pageNumber: number; viewport: { x: number; y: number; width: number; height: number } };
      assert.deepEqual(state, { pageNumber: 1, direction: 'down', moved: true, reachedBoundary: false, viewport: { x: 0, y: 0.2, width: 0.68, height: 0.68 / 15 } });
      return [assistantMessage('The lower part of page 1 is now visible.')];
    }),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect the full page for key details.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Top of the page. Bottom of the page.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'observe',
    documentAdapters: [adapter], viewerAspectRatio: 1.5,
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.match(result.toolEvents.find((event) => event.toolName === 'scroll_document')?.detail ?? '', /Scrolled down on page 1/);
});

test('annotate_text applies a unique text match on a page opened through document navigation', async () => {
  const adapter = new PagedDocumentAdapter('manual.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20" font-size="10">Definitions</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="12" y="50" font-size="10">FASTENING TORQUE</text><text x="12" y="70" font-size="10">Tighten the cover bolts to 12 N-m.</text></svg>' },
    ],
  } as unknown as PreviewReport, 'text-navigation-document');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'text-nav-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'text-nav-inspect-start' })]),
    modelResponse([functionCall('search_document', { query: '12 N-m' }, { callId: 'text-nav-search' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The torque value appears on the second page.' }, { callId: 'text-nav-open' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'text-nav-inspect-page-2' })]),
    modelResponse([functionCall('select_text', { text: '12 N-m' }, { callId: 'text-nav-select' })]),
    modelResponse([functionCall('annotate_text', {
      text: '12 N-m', label: 'FASTENING TORQUE', note: 'Cover bolts require 12 N-m.',
      reason: 'The specified torque is printed beside the cover-bolt instruction.', confidence: 0.9,
      reviewPriority: 'medium', requiresReview: false,
    }, { callId: 'text-nav-annotate' })]),
    modelResponse([assistantMessage('The torque value was recorded from page 2.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Find the fastening torque.',
    guidelines: '', correction: '', humanDecisions: '', pageText: '[x=0.033, y=0.050, w=0.2, h=0.05] Definitions',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2, mode: 'assist',
    documentId: 'text-navigation-document', documentAdapters: [adapter], allowNavigation: true,
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0]?.pageNumber, 2);
  assert.equal(result.annotations[0]?.label, 'FASTENING TORQUE');
  assert.match(result.annotations[0]?.excerpt ?? '', /12 N-m/);
  const storedAnnotation = adapter.listAnnotations()[0];
  assert.equal(adapter.listAnnotations().length, 1);
  assert.equal(storedAnnotation?.target.kind, 'page');
  assert.equal(storedAnnotation?.target.kind === 'page' ? storedAnnotation.target.page : null, 2);
  assert.equal(result.toolEvents.some((event) => event.toolName === 'select_text' && event.pageNumber === 2), true);
  assert.equal(result.toolEvents.some((event) => event.toolName === 'annotate_text' && event.pageNumber === 2), true);
});

test('annotate_text refuses repeated text matches instead of guessing a region', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'ambiguous-text-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'ambiguous-text-inspect' })]),
    modelResponse([functionCall('select_text', { text: '12 N-m' }, { callId: 'ambiguous-text-select' })]),
    modelResponse([functionCall('annotate_text', {
      text: '12 N-m', label: 'FASTENING TORQUE', note: 'A torque value appears.',
      reason: 'The value should be recorded.', confidence: 0.8, reviewPriority: 'medium', requiresReview: false,
    }, { callId: 'ambiguous-text-annotate' })]),
    modelResponse([assistantMessage('The repeated value was not annotated because its location is ambiguous.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Find the fastening torque.',
    guidelines: '', correction: '', humanDecisions: '',
    pageText: '[x=0.100, y=0.100, w=0.300, h=0.030] Maximum torque is 12 N-m.\n[x=0.100, y=0.300, w=0.300, h=0.030] Maximum torque is 12 N-m.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.annotations, []);
  assert.match(result.toolEvents.find((event) => event.toolName === 'annotate_text')?.detail ?? '', /not resolve/);
});

test('batch-mode review requests can be queued without pausing the document workflow', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'batch-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'batch-inspect' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.2, width: 0.4, height: 0.1,
      label: 'Ambiguous clause', note: 'Review this clause.', reason: 'The condition is not defined.',
      confidence: 0.55, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'batch-review' })]),
    modelResponse([assistantMessage('The candidate is queued; continue with the next document.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find the clause.',
    guidelines: '', correction: '', humanDecisions: '', pageText: '',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', requireToolApproval: false,
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.approvalRunId, undefined);
  assert.equal(result.annotations[0]?.requiresReview, true);
});

test('a rejected SDK approval resumes the same RunState without re-adding the candidate', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reject-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-inspect' })]),
    modelResponse([functionCall('request_review', {
      x: 0.2, y: 0.25, width: 0.4, height: 0.1,
      label: 'Uncertain region', note: 'Possible match.', reason: 'The text is ambiguous.',
      confidence: 0.4, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'reject-review' })]),
    modelResponse([assistantMessage('The reviewer rejected the match, so I did not apply it.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find matching clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: '',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist',
  }, model);
  assert.equal(paused.status, 'interrupted');
  const resumed = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: false });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.deepEqual(resumed.annotations, []);
});

test('rejecting a review keeps the RunState annotation array live for findings on a later page', async () => {
  const adapter = new PagedDocumentAdapter('corrected-review.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Termination for convenience</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Thirty days written notice</text></svg>' },
    ],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reject-later-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-later-inspect-1' })]),
    modelResponse([functionCall('request_review', {
      x: 0.2, y: 0.25, width: 0.45, height: 0.1,
      label: 'HIGH RISK', note: 'Unilateral termination.',
      reason: 'The notice requirement needs human review.', excerpt: 'terminate for convenience',
      confidence: 0.9, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'reject-later-review' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'Continue to the remaining notice clause after review.' }, { callId: 'reject-later-navigate' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-later-inspect-2' })]),
    modelResponse([functionCall('annotate_region', {
      x: 0.15, y: 0.2, width: 0.55, height: 0.1,
      label: 'LOW RISK', note: 'Thirty days written notice meets the reviewed rule.',
      reason: 'The clause provides at least thirty days of written notice.',
      excerpt: 'Thirty days written notice', confidence: 0.9, reviewPriority: 'low', requiresReview: false,
    }, { callId: 'reject-later-annotate' })]),
    modelResponse([assistantMessage('The corrected rule was applied to the remaining page.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find and classify termination clauses.',
    guidelines: 'Clauses with at least thirty days of written notice are LOW RISK.',
    correction: '', humanDecisions: '', pageText: 'Termination for convenience.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2,
    documentAdapters: [adapter], allowNavigation: true, mode: 'assist',
  }, model);

  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.annotations[0]?.approvalId, paused.approvalId);
  const resumed = await resumeDocumentAgentRun({
    runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: false,
    note: '[RULE FOR REMAINING PAGES] Classify 30-day notice termination clauses as LOW RISK.',
  });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.ok(resumed.annotations.some((item) => item.label === 'LOW RISK' && item.pageNumber === 2), 'the rejected candidate must not detach the resumed Agent tool closure from its annotation list');
  assert.equal(adapter.listAnnotations().find((item) => item.label === 'LOW RISK')?.status, 'auto');
});

test('restores an encrypted pending RunState with rebound provider settings and resumes it', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'restore-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'restore-inspect' })]),
    modelResponse([functionCall('delegate_page_annotator', { request: 'Classify this unclear qualification.' }, { callId: 'restore-annotator' })]),
    modelResponse([assistantMessage(JSON.stringify({ proposals: [{
      excerpt: 'unclear qualification', label: 'NEEDS REVIEW', note: 'The qualification is not precise.',
      reason: 'The text leaves the trigger unclear.', reviewPriority: 'high', requiresReview: true, uncertainty: 'The scope needs a human decision.',
    }] }))]),
    modelResponse([functionCall('delegate_page_reader', { question: 'Read the qualification and its surrounding sentence.' }, { callId: 'restore-reader' })]),
    modelResponse([assistantMessage(JSON.stringify({ pageSummary: 'The qualification needs human review.', evidenceBlocks: [], uncertainties: [] }))]),
    modelResponse([functionCall('request_review', {
      x: 0.25, y: 0.3, width: 0.35, height: 0.12,
      label: 'Needs review', note: 'Review after restart.', reason: 'The statement has an unclear qualification.',
      excerpt: 'unclear qualification', reviewPriority: 'high', requiresReview: true,
    }, { callId: 'restore-review' })]),
    modelResponder((call) => {
      assert.equal(call.request.tools.some((tool) => tool.type === 'function' && tool.name === 'delegate_page_annotator'), false,
        'restored RunState keeps the page-level Annotator delegation budget');
      assert.equal(call.request.tools.some((tool) => tool.type === 'function' && tool.name === 'delegate_page_reader'), false,
        'restored RunState keeps the bounded Reader delegation budget');
      return [assistantMessage('The approved finding was processed after restoring the saved run.')];
    }),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find statements needing review.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'A statement with an unclear qualification.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
    documentId: 'versioned-document-session', sourceHash: 'a'.repeat(64),
    providerCredentialIdentity: 'original-live-client',
  }, model);
  assert.equal(paused.status, 'interrupted');
  assert.ok(paused.approvalRunId);
  assert.equal((await getPendingAgentRunInfo(paused.approvalRunId!))?.sourceHash, 'a'.repeat(64));
  assert.equal(pendingAgentRunMatchesProviderIdentity(paused.approvalRunId!, 'original-live-client'), true);
  const persistedRun = await pendingRunStore.get<Record<string, unknown>>('pending-agent-runs', paused.approvalRunId!);
  assert.ok(persistedRun);
  assert.equal('providerCredentialIdentity' in persistedRun, false, 'the in-memory credential identity must never be persisted');
  assert.equal(JSON.stringify(persistedRun).includes('original-live-client'), false, 'the provider identity string is not present anywhere in the encrypted pending-run payload');
  assert.equal(persistedRun.annotatorDelegationCount, 1);
  assert.deepEqual(persistedRun.annotatorDelegatedPages, [1]);
  assert.equal(persistedRun.readerDelegationCount, 1);
  assert.deepEqual(persistedRun.readerDelegatedPages, [1]);

  const restored = await restorePendingAgentRun({
    runId: paused.approvalRunId!, providerName: 'openai-api', providerCredentialIdentity: 'current-live-client', forceRestore: true, testModel: model,
  });
  assert.equal(restored, true);
  assert.equal(pendingAgentRunMatchesProviderIdentity(paused.approvalRunId!, 'current-live-client'), true);
  const resumed = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.annotations.length, 0);
  assert.equal(await getPendingAgentRunInfo(paused.approvalRunId!), null, 'completed restored runs remove their durable checkpoint');
});

test('concurrent duplicate approvals cannot apply the same workbook mutation twice', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const source = Buffer.from(await workbook.xlsx.writeBuffer());
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'duplicate-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'duplicate-inspect' })]),
    modelResponse([functionCall('get_workbook_outline', {}, { callId: 'duplicate-workbook' })]),
    modelResponse([functionCall('inspect_sheet', { sheetName: 'Customers' }, { callId: 'duplicate-sheet' })]),
    modelResponse([functionCall('read_range', { sheetName: 'Customers', range: 'A1:B2' }, { callId: 'duplicate-range' })]),
    modelResponse([functionCall('write_cell', {
      sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'The evidence supports a high-risk label.', confidence: 0.9, reviewPriority: 'medium',
      requiresReview: true,
    }, { callId: 'duplicate-write' })]),
    modelResponse([assistantMessage('The approved cell update is complete.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify the customer.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Customer table.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
    spreadsheet: adapter, documentAdapters: [adapter],
  }, model);
  assert.equal(paused.status, 'interrupted');
  const decision = { runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: true };
  const results = await Promise.allSettled([
    resumeDocumentAgentRun(decision),
    resumeDocumentAgentRun(decision),
  ]);
  const completed = results.find((result) => result.status === 'fulfilled');
  const duplicate = results.find((result) => result.status === 'rejected');
  assert.equal(completed?.status, 'fulfilled');
  assert.equal(duplicate?.status, 'rejected');
  assert.equal((duplicate as PromiseRejectedResult | undefined)?.reason?.status, 409);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, 'HIGH');
  assert.equal(adapter.getChanges().length, 1);
  await assert.rejects(resumeDocumentAgentRun(decision), (error: unknown) => error instanceof Error && 'status' in error && (error as Error & { status: number }).status === 410);
  assert.equal(adapter.getChanges().length, 1);
  model.assertComplete();
});

test('the workbook tools inspect and edit a sheet, pausing and resuming the same RunState for each write', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([
    ['Customer churn review'],
    ['Internal use only'],
    ['Name', 'Tickets'],
    ['Aki', 0],
    ['Mina', 8],
  ]);
  const source = Buffer.from(await workbook.xlsx.writeBuffer());
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source);
  const originalWorkbook = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', source, adapter.documentId);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'xlsx-inspect' })]),
    modelResponse([functionCall('get_workbook_outline', {}, { callId: 'xlsx-workbook' })]),
    modelResponse([functionCall('inspect_sheet', { sheetName: 'Customers' }, { callId: 'xlsx-sheet' })]),
    modelResponse([functionCall('read_range', { sheetName: 'Customers', range: 'A1:B5' }, { callId: 'xlsx-range' })]),
    modelResponse([functionCall('search_document', { query: 'Mina' }, { callId: 'xlsx-global-search' })]),
    modelResponse([functionCall('create_column', { sheetName: 'Customers', header: 'Churn Risk', headerRow: 3, reason: 'Add a column for risk labels beside the customer table.', reviewPriority: 'medium', requiresReview: true }, { callId: 'xlsx-column' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'C4', value: 'LOW', reason: 'No support tickets indicate low risk.', confidence: 0.94, reviewPriority: 'low', requiresReview: true }, { callId: 'xlsx-cell' })]),
    modelResponse([functionCall('write_range', { sheetName: 'Customers', startAddress: 'D4', values: Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, column) => `R${row + 1}C${column + 1}`)), reason: 'Review the complete row matrix.', confidence: 0.91, reviewPriority: 'high', requiresReview: false }, { callId: 'xlsx-range-write' })]),
    modelResponse([assistantMessage('The workbook was classified with approved changes.')]),
  ]);

  const pausedColumn = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify each customer by churn risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Customer table.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', spreadsheet: adapter, documentAdapters: [adapter], allowNavigation: true,
  }, model);
  assert.equal(pausedColumn.status, 'interrupted');
  assert.equal(pausedColumn.toolEvents.some((event) => event.toolName === 'search_document'), true);
  assert.equal(pausedColumn.spreadsheetChanges?.[0]?.operation, 'create_column');
  assert.equal(pausedColumn.spreadsheetChanges?.[0]?.range, 'C3');
  assert.ok(adapter.getChanges().some((change) => change.id === pausedColumn.approvalId && change.requiresReview), 'the interrupted tool proposal is registered in the session adapter for review context');
  const originalContext = adapter.readChangeContext(pausedColumn.approvalId!, originalWorkbook);
  assert.equal(originalContext.targetRange, 'C3');
  assert.equal(originalContext.rows.find((row) => row.some((cell) => cell.address === 'C3'))?.find((cell) => cell.address === 'C3')?.value, null);
  assert.equal(adapter.readRange('Customers', 'C3').rows[0]?.[0]?.value, null);

  const pausedCell = await resumeDocumentAgentRun({ runId: pausedColumn.approvalRunId!, approvalId: pausedColumn.approvalId!, approved: true });
  assert.equal(pausedCell.status, 'interrupted');
  assert.equal(pausedCell.spreadsheetChanges?.find((change) => change.id === pausedColumn.approvalId)?.approved, true);
  assert.equal(adapter.readRange('Customers', 'A1').rows[0]?.[0]?.value, 'Customer churn review');
  assert.equal(adapter.readRange('Customers', 'C1').rows[0]?.[0]?.value, null);
  assert.equal(adapter.readRange('Customers', 'C3').rows[0]?.[0]?.value, 'Churn Risk');
  assert.equal(adapter.readRange('Customers', 'C4').rows[0]?.[0]?.value, null);

  const pausedRange = await resumeDocumentAgentRun({ runId: pausedCell.approvalRunId!, approvalId: pausedCell.approvalId!, approved: true });
  assert.equal(pausedRange.status, 'interrupted');
  assert.equal(pausedRange.spreadsheetChanges?.find((change) => change.id === pausedRange.approvalId)?.range, 'D4:M13');
  assert.ok(adapter.getChanges().some((change) => change.id === pausedRange.approvalId && change.requiresReview), 'the pending range is registered in the session adapter');
  const rangeContext = adapter.readChangeContext(pausedRange.approvalId!, originalWorkbook, 0);
  assert.equal(rangeContext.viewMode, 'range');
  assert.equal(rangeContext.range, 'D4:K8');
  assert.equal(rangeContext.pageCount, 4);

  const completed = await resumeDocumentAgentRun({ runId: pausedRange.approvalRunId!, approvalId: pausedRange.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.spreadsheetChanges?.find((change) => change.id === pausedRange.approvalId)?.approved, true);
  assert.equal(adapter.readRange('Customers', 'C4').rows[0]?.[0]?.value, 'LOW');
  assert.equal(adapter.readRange('Customers', 'D4').rows[0]?.[0]?.value, 'R1C1');
});

test('Autopilot applies clear high-priority workbook writes and marks them for the report', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'autopilot-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'autopilot-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', {
      sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'The row clearly shows repeated failed payments.',
      confidence: 0.02, reviewPriority: 'high', requiresReview: false,
    }, { callId: 'autopilot-xlsx-high' })]),
    modelResponse([assistantMessage('The clear high-priority classification was applied and will be reported.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'autopilot', spreadsheet: adapter, documentAdapters: [adapter],
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.spreadsheetChanges?.[0]?.reviewPriority, 'high');
  assert.equal(result.spreadsheetChanges?.[0]?.requiresReview, false);
  assert.equal(result.spreadsheetChanges?.[0]?.approved, true);
  assert.equal(result.spreadsheetChanges?.[0]?.reviewOutcome, undefined, 'automatic application is not a human approval');
  assert.deepEqual(result.inspectedPages, [], 'workbook completeness is based on workbook evidence, not PDF page checkpoints');
  assert.deepEqual(result.remainingPages, []);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, 'HIGH');
  assert.match(result.toolEvents.find((event) => event.toolName === 'write_cell')?.detail ?? '', /Autopilot will report this important workbook result/);
});

test('Assist applies clear low-priority workbook values without an approval interruption', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'assist-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'assist-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', {
      sheetName: 'Customers', address: 'B2', value: 'LOW', reason: 'The row shows no support tickets and recent activity.',
      confidence: 0.99, reviewPriority: 'low', requiresReview: false,
    }, { callId: 'assist-xlsx-low' })]),
    modelResponse([assistantMessage('The clear low-priority result was applied.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', spreadsheet: adapter, documentAdapters: [adapter],
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.approvalRunId, undefined);
  assert.equal(result.spreadsheetChanges?.[0]?.approved, true);
  assert.equal(result.spreadsheetChanges?.[0]?.reviewOutcome, undefined);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, 'LOW');
});

test('rejecting an Excel cell write resumes the same RunState and leaves the workbook unchanged', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reject-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'Recent activity indicates high risk.', confidence: 0.92, reviewPriority: 'high', requiresReview: false }, { callId: 'reject-xlsx-cell' })]),
    modelResponse([assistantMessage('The cell suggestion was rejected and the workbook remains unchanged.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', spreadsheet: adapter,
  }, model);
  assert.equal(paused.status, 'interrupted');
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, null);

  const rejected = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: false, note: 'This row lacks enough evidence.' });
  model.assertComplete();
  assert.equal(rejected.status, 'complete');
  assert.equal(rejected.spreadsheetChanges?.[0]?.rejected, true);
  assert.equal(adapter.getChanges().find((change) => change.id === paused.approvalId)?.rejected, true, 'the persisted workbook adapter must retain the rejection instead of restoring a pending proposal');
  assert.equal(adapter.getChanges().find((change) => change.id === paused.approvalId)?.requiresReview, true, 'a rejected proposal keeps its review history but is no longer unresolved');
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, null);
});

test('batch mode writes workbook changes without pausing between documents', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'batch-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'batch-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'LOW', reason: 'The row shows recent activity and no support cases.', confidence: 0.93, reviewPriority: 'low', requiresReview: false }, { callId: 'batch-xlsx-cell' })]),
    modelResponse([assistantMessage('The workbook was processed as part of the batch.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', requireToolApproval: false, spreadsheet: adapter,
  }, model);
  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.approvalRunId, undefined);
  assert.equal(result.spreadsheetChanges?.[0]?.approved, true);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, 'LOW');
});

test('batch mode queues uncertain workbook values and continues without applying them', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'batch-review-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'batch-review-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'The evidence is incomplete.', confidence: null, reviewPriority: 'high', requiresReview: true }, { callId: 'batch-review-write' })]),
    modelResponse([assistantMessage('The uncertain item is staged for human review.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', requireToolApproval: false, spreadsheet: adapter,
  }, model);
  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.spreadsheetChanges?.[0]?.requiresReview, true);
  assert.equal(result.spreadsheetChanges?.[0]?.reviewPriority, 'high');
  assert.equal(result.spreadsheetChanges?.[0]?.approved, undefined);
  assert.equal(adapter.getChanges()[0]?.requiresReview, true);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, null);
});

test('the agent can search across the full paged document through the shared adapter', async () => {
  const adapter = new PagedDocumentAdapter('contract.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg><text>Definitions</text></svg>' },
      { number: 2, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: '<svg><text>Termination for convenience</text></svg>' },
    ],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'adapter-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'adapter-inspect' })]),
    modelResponse([functionCall('search_document', { query: 'termination' }, { callId: 'adapter-search' })]),
    modelResponse([assistantMessage('A relevant clause appears on page 2; the current page remains the visual target.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find termination clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Definitions.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2,
    mode: 'observe', documentAdapters: [adapter], allowNavigation: true,
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.remainingPages, [2]);
  assert.equal(result.toolEvents.find((event) => event.toolName === 'search_document')?.detail, 'Searched the full document for “termination”; found 1 text or cell matches.');
});

test('the annotator delegates reading, then resumes the same RunState after human approval', async () => {
  const adapter = new PagedDocumentAdapter('accounts.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Definitions</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Name | Status</text><text x="4" y="40">Aki | Pending</text></svg>' },
    ],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reader-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reader-inspect' })]),
    modelResponse([functionCall('search_document', { query: 'Aki' }, { callId: 'reader-search' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The matching account row is on page 2.' }, { callId: 'reader-navigate' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reader-inspect-2' })]),
    modelResponse([functionCall('delegate_page_reader', { question: 'Read the table row and preserve the evidence.' }, { callId: 'reader-delegate' })]),
    modelResponse([assistantMessage(JSON.stringify({
      pageSummary: 'A two-column row links the account name to its review status.',
      evidenceBlocks: [{ excerpt: 'Aki | Pending', description: 'One table row beneath the Name and Status headings.', boundingBox: { x: 0.12, y: 0.3, width: 0.5, height: 0.08 }, readingPriority: 'medium' }],
      uncertainties: [],
    }))]),
    modelResponse([functionCall('request_review', {
      x: 0.12, y: 0.3, width: 0.5, height: 0.08,
      label: 'MEDIUM RISK', note: 'The row is pending.', reason: 'The status suggests possible risk but needs human judgment.', excerpt: 'Aki | Pending',
      confidence: 0.7, reviewPriority: 'medium', requiresReview: true,
    }, { callId: 'reader-review-1' })]),
    modelResponse([assistantMessage('The reviewer confirmed the classification.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify every account row.',
    guidelines: 'Use the Status column and do not infer missing data.', correction: '', humanDecisions: '',
    pageText: 'Definitions.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 2, mode: 'assist', documentAdapters: [adapter], allowNavigation: true,
  }, model);

  assert.equal(result.status, 'interrupted');
  assert.ok(result.approvalRunId);
  assert.ok(result.approvalId);
  assert.deepEqual(result.toolEvents.filter((event) => event.toolName === 'delegate_page_reader').map((event) => event.status), ['active', 'complete']);
  assert.equal(result.blockedPage, 2);
  assert.equal(result.toolEvents.find((event) => event.toolName === 'delegate_page_reader')?.pageNumber, 2);
  assert.match(result.toolEvents.find((event) => event.toolName === 'delegate_page_reader' && event.status === 'complete')?.detail ?? '', /Reader Agent returned 1 evidence blocks.*page 2/);

  const resumed = await resumeDocumentAgentRun({ runId: result.approvalRunId!, approvalId: result.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.match(resumed.toolEvents.find((event) => event.toolName === 'annotate_region')?.detail ?? '', /approved by a human/);
  assert.equal(resumed.toolEvents.some((event) => event.toolName === 'delegate_page_reader'), false, 'Reader activity is not replayed during resume');
});

test('the read-only Annotator specialist proposes labels and the Orchestrator grounds and applies text', async () => {
  const adapter = new PagedDocumentAdapter('accounts.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Definitions</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Name | Status</text><text x="4" y="40">Aki | Pending</text></svg>' },
    ],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'annotator-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'annotator-inspect' })]),
    modelResponse([functionCall('search_document', { query: 'Aki' }, { callId: 'annotator-search' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The account row is on page 2.' }, { callId: 'annotator-navigate' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'annotator-inspect-page-2' })]),
    modelResponse([functionCall('delegate_page_annotator', { request: 'Classify the account status using the current page and task rules.' }, { callId: 'annotator-delegate' })]),
    modelResponse([assistantMessage(JSON.stringify({ proposals: [{
      excerpt: 'Aki | Pending', label: 'PENDING STATUS', note: 'The account is listed as pending.',
      reason: 'The Status column reads Pending.', reviewPriority: 'medium', requiresReview: false, uncertainty: '',
    }] }))]),
    modelResponse([functionCall('select_text', { text: 'Aki | Pending' }, { callId: 'annotator-select' })]),
    modelResponse([functionCall('annotate_text', {
      text: 'Aki | Pending', label: 'PENDING STATUS', note: 'The account is listed as pending.',
      reason: 'The Status column reads Pending.', confidence: 0.9, reviewPriority: 'medium', requiresReview: false,
    }, { callId: 'annotator-apply' })]),
    modelResponse([assistantMessage('I confirmed the exact table row and applied the parent-owned annotation.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Classify every account row.',
    guidelines: 'Use the Status column and do not infer missing data.', correction: '', humanDecisions: '',
    pageText: 'Definitions.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 2, mode: 'assist', documentAdapters: [adapter], allowNavigation: true,
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0]?.pageNumber, 2);
  assert.equal(result.annotations[0]?.label, 'PENDING STATUS');
  assert.equal(result.annotations[0]?.excerpt, 'Aki | Pending');
  assert.deepEqual(adapter.listAnnotations().map((annotation) => annotation.label), ['PENDING STATUS']);
  const delegation = result.toolEvents.find((event) => event.toolName === 'delegate_page_annotator' && event.status === 'complete');
  assert.deepEqual(result.toolEvents.filter((event) => event.toolName === 'delegate_page_annotator').map((event) => event.status), ['active', 'complete']);
  assert.equal(delegation?.pageNumber, 2);
  assert.match(delegation?.detail ?? '', /returned 1 grounded proposal/);
  assert.deepEqual(result.toolEvents.slice(-2).map((event) => event.toolName), ['select_text', 'annotate_text']);
});

test('the Reader Agent receives the latest high-detail crop after the Orchestrator scrolls', async () => {
  const adapter = new PagedDocumentAdapter('scroll-reader.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Overview</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">A small, dense table value</text></svg>' },
    ],
  } as unknown as PreviewReport);
  let suppliedViewport: { x: number; y: number; width: number; height: number };
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'scroll-reader-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'scroll-reader-inspect-start' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The dense table is on page 2.' }, { callId: 'scroll-reader-open' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'scroll-reader-inspect-page-2' })]),
    modelResponse([functionCall('scroll_document', { direction: 'down', amount: 0.2 }, { callId: 'scroll-reader-detail' })]),
    modelResponse([functionCall('delegate_page_reader', { question: 'Read the small value in the focused table crop.' }, { callId: 'scroll-reader-delegate' })]),
    modelResponder((call) => {
      const input = JSON.stringify(call.request.input);
      assert.match(input, /data:image\/png;base64,/u, 'the Reader should receive the high-detail crop from the latest scroll action');
      assert.match(input, /"detail":"high"/u, 'the delegated crop should retain high image detail');
      assert.doesNotMatch(input, /data:image\/jpeg;base64,/u, 'the Reader should not fall back to the lower-detail navigation overview after scrolling');
      const text = inputTextFromModelCall(call);
      const viewportMatch = text.match(/imageViewport .*?: (\{[^\n]+?\})\./u);
      assert.ok(viewportMatch, 'the Reader receives the image crop mapping independently of full-page text coordinates');
      suppliedViewport = JSON.parse(viewportMatch[1]!);
      assert.ok(suppliedViewport.y > 0);
      assert.ok(suppliedViewport.width < 1);
      return [assistantMessage(JSON.stringify({
        pageSummary: 'A dense value is visible in the focused table crop.',
        evidenceBlocks: [{ excerpt: '120', description: 'The visible table value.', boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 }, readingPriority: 'medium' }], uncertainties: [],
      }))];
    }),
    modelResponder((call) => {
      const output = readToolResult(call, 'delegate_page_reader');
      assert.equal(output.coordinateSpace, 'full_page');
      assert.equal(output.pageNumber, 2);
      const blocks = output.evidenceBlocks as Array<{ boundingBox: typeof suppliedViewport }>;
      assert.deepEqual(blocks[0]?.boundingBox, {
        x: suppliedViewport.x + 0.1 * suppliedViewport.width,
        y: suppliedViewport.y + 0.2 * suppliedViewport.height,
        width: 0.4 * suppliedViewport.width,
        height: 0.1 * suppliedViewport.height,
      }, 'the parent receives full-page coordinates, not coordinates relative to the cropped image');
      return [assistantMessage('The detail crop was delegated to the Reader.')];
    }),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect the dense table on page 2.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Overview.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 2, documentId: 'scroll-reader', documentAdapters: [adapter], allowNavigation: true, mode: 'observe',
  }, model);
  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.visitedPages, [1, 2]);
  assert.ok(result.toolEvents.some((event) => event.toolName === 'delegate_page_reader' && event.status === 'complete'));
});

test('the Annotator preserves image-only evidence proposals and keeps item-only decisions scoped', async () => {
  const itemOnlyDecision = '[THIS ITEM ONLY; DO NOT GENERALIZE] P.1: Use DATE for this one purchase-date annotation.';
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'annotator-image-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'annotator-image-inspect' })]),
    modelResponse([functionCall('delegate_page_annotator', { request: 'Classify the visible current-page callouts.' }, { callId: 'annotator-image-delegate' })]),
    modelResponder((call) => {
      assert.equal(call.request.modelSettings.maxTokens, documentAnnotatorLimits.maxOutputTokens);
      const text = inputTextFromModelCall(call);
      const payload = JSON.parse(text) as { pageNumber: number; humanDecisions: string };
      assert.equal(payload.pageNumber, 2);
      assert.equal(payload.humanDecisions, itemOnlyDecision);
      return [assistantMessage(JSON.stringify({ proposals: [{
        excerpt: 'CALLOUT: 28% RETURN FEE', label: 'RETURN FEE', note: 'A return fee is shown in the visual callout.',
        reason: 'The callout displays a 28% return fee.', reviewPriority: 'medium', requiresReview: false, uncertainty: '',
      }] }))];
    }),
    modelResponse([assistantMessage('The image-grounded callout is a proposal only; no annotation was applied.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Classify current-page callouts.',
    guidelines: 'Use evidence visible in either the page image or extracted text.', correction: '', humanDecisions: itemOnlyDecision,
    pageText: 'Page 2 contains typed terms, but no return-fee text.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 2, totalPages: 2, mode: 'assist',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations.length, 0, 'the child proposal remains advisory until the parent independently verifies and applies it');
  assert.match(result.toolEvents.find((event) => event.toolName === 'delegate_page_annotator' && event.status === 'complete')?.detail ?? '', /returned 1 grounded proposal/);
});

test('a high-priority Annotator proposal still pauses in the parent Human Review path', async () => {
  const adapter = new PagedDocumentAdapter('agreement.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Either party may terminate without cause.</text></svg>' }],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'annotator-review-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'annotator-review-inspect' })]),
    modelResponse([functionCall('delegate_page_annotator', { request: 'Classify the visible termination condition.' }, { callId: 'annotator-review-delegate' })]),
    modelResponse([assistantMessage(JSON.stringify({ proposals: [{
      excerpt: 'Either party may terminate without cause.', label: 'HIGH RISK', note: 'Either party can end the agreement without cause.',
      reason: 'The visible text allows unilateral termination without a stated trigger.', reviewPriority: 'high', requiresReview: true, uncertainty: 'Confirm the business impact with a reviewer.',
    }] }))]),
    modelResponse([functionCall('select_text', { text: 'Either party may terminate without cause.' }, { callId: 'annotator-review-select' })]),
    modelResponse([functionCall('annotate_text', {
      text: 'Either party may terminate without cause.', label: 'HIGH RISK', note: 'Either party can end the agreement without cause.',
      reason: 'The visible text allows unilateral termination without a stated trigger.', confidence: 0.8, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'annotator-review-text' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.2, width: 0.5, height: 0.08, label: 'HIGH RISK',
      note: 'Either party can end the agreement without cause.',
      reason: 'The visible text allows unilateral termination without a stated trigger.',
      excerpt: 'Either party may terminate without cause.', confidence: 0.8, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'annotator-review-approval' })]),
    modelResponse([assistantMessage('The approved parent tool call is complete.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Find unilateral termination rights.',
    guidelines: 'High-risk clauses need human review.', correction: '', humanDecisions: '',
    pageText: '[x=0.100, y=0.200, w=0.500, h=0.080] Either party may terminate without cause.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist', documentAdapters: [adapter],
  }, model);

  assert.equal(result.status, 'interrupted');
  assert.ok(result.approvalRunId);
  assert.ok(result.approvalId);
  assert.equal(result.annotations.length, 1, 'the parent retains the pending approval candidate');
  assert.equal(result.annotations[0]?.requiresReview, true);
  assert.equal(result.annotations[0]?.reviewedByHuman, undefined, 'the parent has not recorded human approval yet');
  assert.deepEqual(result.toolEvents.filter((event) => event.toolName === 'delegate_page_annotator').map((event) => event.status), ['active', 'complete']);
  const resumed = await resumeDocumentAgentRun({ runId: result.approvalRunId!, approvalId: result.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.toolEvents.find((event) => event.toolName === 'annotate_region')?.status, 'complete');
  assert.deepEqual(adapter.listAnnotations().map(({ label, status, evidence }) => ({ label, status, evidence })), [
    { label: 'HIGH RISK', status: 'approved', evidence: 'Either party may terminate without cause.' },
  ]);
});

test('the agent can list existing page annotations to avoid duplicates', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'list-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'list-inspect' })]),
    modelResponse([functionCall('list_annotations', { pageNumber: 1 }, { callId: 'list-existing' })]),
    modelResponse([assistantMessage('Reviewed the existing annotation before continuing.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Review this page without duplicating prior work.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'A sample clause.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2, mode: 'assist',
    existingAnnotations: [{
      id: 'saved-annotation', pageNumber: 1, x: 0.2, y: 0.25, width: 0.3, height: 0.1,
      label: 'HIGH RISK', note: 'Human-reviewed termination right.', excerpt: 'Either party may terminate.', status: 'active',
    }, {
      id: 'other-page', pageNumber: 2, x: 0.2, y: 0.25, width: 0.3, height: 0.1,
      label: 'LOW RISK', note: 'Other page.', status: 'needs_review',
    }],
  }, model);
  model.assertComplete();
  const listing = result.toolEvents.find((event) => event.toolName === 'list_annotations');
  assert.match(listing?.detail ?? '', /Listed 1 existing annotation on page 1/);
});

test('updating and deleting an annotation each pause for approval and resume the same RunState', async () => {
  const existing = {
    id: 'existing-risk', pageNumber: 1, x: 0.2, y: 0.25, width: 0.4, height: 0.12,
    label: 'MEDIUM RISK', note: 'Conditional termination right.', excerpt: 'for cause', status: 'active' as const,
  };
  const adapter = new PagedDocumentAdapter('existing-risk.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 240, heightPoints: 320, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><text x="20" y="40">Either party may terminate for cause.</text></svg>' }],
  } as unknown as PreviewReport, 'existing-risk-doc');
  const sourceTarget = {
    kind: 'page' as const, page: 1, boundingBox: { x: existing.x, y: existing.y, width: existing.width, height: existing.height },
    textAnchor: { quote: { exact: 'for cause', prefix: 'terminate ', suffix: '.' }, position: { start: 27, end: 36, unit: 'normalized-page-text' as const } },
  };
  adapter.annotate({
    id: existing.id, documentId: 'existing-risk-doc', sourceHash: 'preserved-source-hash', target: sourceTarget,
    label: existing.label, note: existing.note, evidence: existing.excerpt, explanation: existing.note,
    reviewPriority: 'medium', status: 'approved', source: 'manual',
  });
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'mutation-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'mutation-inspect' })]),
    modelResponse([functionCall('list_annotations', { pageNumber: 1 }, { callId: 'mutation-list' })]),
    modelResponse([functionCall('update_annotation', {
      annotationId: 'existing-risk', label: 'HIGH RISK', note: 'Unilateral termination without a defined breach condition.',
      reason: 'The existing label understated the one-sided termination right.',
    }, { callId: 'mutation-update' })]),
    modelResponse([functionCall('delete_annotation', {
      annotationId: 'existing-risk', reason: 'The user confirmed this annotation was entered on the wrong clause.',
    }, { callId: 'mutation-delete' })]),
    modelResponse([assistantMessage('Both approved annotation operations are complete.')]),
  ]);
  const first = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Correct prior risk labels and remove stale annotations.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Either party may terminate for cause.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist', existingAnnotations: [existing],
    documentId: 'existing-risk-doc', documentAdapters: [adapter],
  }, model);
  assert.equal(first.status, 'interrupted');
  assert.equal(first.annotationOperations?.[0]?.operation, 'update');
  assert.equal(first.annotationOperations?.[0]?.status, 'needs_review');
  assert.equal(first.annotationOperations?.[0]?.approvalRunId, first.approvalRunId);
  assert.equal(first.annotationOperations?.[0]?.approvalId, first.approvalId);

  const second = await resumeDocumentAgentRun({ runId: first.approvalRunId!, approvalId: first.approvalId!, approved: true });
  assert.equal(second.status, 'interrupted');
  assert.equal(second.annotationOperations?.find((item) => item.operation === 'update')?.status, 'approved');
  assert.equal(second.annotationOperations?.find((item) => item.operation === 'delete')?.existingLabel, 'HIGH RISK');
  const corrected = adapter.listAnnotations()[0]!;
  assert.deepEqual(corrected.target, sourceTarget, 'correcting an imported annotation retains its exact text anchor');
  assert.equal(corrected.source, 'manual');
  assert.equal(corrected.sourceHash, 'preserved-source-hash');
  assert.equal(corrected.status, 'corrected');

  const completed = await resumeDocumentAgentRun({ runId: second.approvalRunId!, approvalId: second.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.annotationOperations?.find((item) => item.operation === 'delete')?.status, 'approved');
  assert.deepEqual(adapter.listAnnotations(), []);
});

test('annotations created in the current run can be corrected and removed with review without losing text anchors', async () => {
  const adapter = new PagedDocumentAdapter('current-run.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 240, heightPoints: 320, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><text x="20" y="40">Revenue: 120</text></svg>' }],
  } as unknown as PreviewReport, 'current-run');
  let annotationId = '';
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'current-run-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'current-run-inspect' })]),
    modelResponse([functionCall('annotate_text', {
      text: 'Revenue: 120', label: 'REVENUE', note: 'Revenue amount.', reason: 'The source states revenue of 120.',
      confidence: null, reviewPriority: 'low', requiresReview: false,
    }, { callId: 'current-run-create' })]),
    modelResponder((call) => {
      const created = readToolResult(call, 'annotate_text');
      assert.equal(created.created, true);
      annotationId = String(created.id);
      return [functionCall('update_annotation', {
        annotationId, label: 'REPORTED REVENUE', note: 'Reported revenue is 120.', reason: 'Clarify that the number is reported revenue.',
      }, { callId: 'current-run-update' })];
    }),
    modelResponder((call) => {
      assert.equal(readToolResult(call, 'update_annotation').updated, true);
      return [functionCall('list_annotations', { pageNumber: 1 }, { callId: 'current-run-list' })];
    }),
    modelResponder((call) => {
      const listed = readToolResult(call, 'list_annotations').annotations as Array<{ id: string; label: string }>;
      assert.deepEqual(listed.map(({ id, label }) => ({ id, label })), [{ id: annotationId, label: 'REPORTED REVENUE' }]);
      return [functionCall('delete_annotation', { annotationId, reason: 'The reviewer wants to remove this label after checking it.' }, { callId: 'current-run-delete' })];
    }),
    modelResponder((call) => {
      assert.equal(readToolResult(call, 'delete_annotation').deleted, true);
      return [functionCall('list_annotations', { pageNumber: 1 }, { callId: 'current-run-list-empty' })];
    }),
    modelResponder((call) => {
      assert.deepEqual(readToolResult(call, 'list_annotations').annotations, []);
      return [assistantMessage('The reviewed correction and removal are complete.')];
    }),
  ]);
  const first = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Label the revenue and review any corrections.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Revenue: 120',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', documentId: 'current-run', documentAdapters: [adapter],
  }, model);
  assert.equal(first.status, 'interrupted');
  assert.equal(first.annotationOperations[0]?.status, 'needs_review');
  assert.equal(first.annotationOperations[0]?.annotationId, annotationId);
  const originalRecord = adapter.listAnnotations()[0]!;
  assert.equal(originalRecord.label, 'REVENUE', 'the new label does not change before approval');
  assert.equal(originalRecord.target.kind, 'page');
  assert.ok('textAnchor' in originalRecord.target && originalRecord.target.textAnchor);

  const second = await resumeDocumentAgentRun({ runId: first.approvalRunId!, approvalId: first.approvalId!, approved: true });
  assert.equal(second.status, 'interrupted');
  const correctedRecord = adapter.listAnnotations()[0]!;
  assert.equal(correctedRecord.label, 'REPORTED REVENUE');
  assert.equal(correctedRecord.status, 'corrected');
  assert.deepEqual(correctedRecord.target, originalRecord.target, 'the source text anchors and fragments are retained');
  assert.equal(second.annotationOperations.find((operation) => operation.operation === 'delete')?.existingLabel, 'REPORTED REVENUE');

  const completed = await resumeDocumentAgentRun({ runId: second.approvalRunId!, approvalId: second.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'complete');
  assert.deepEqual(adapter.listAnnotations(), []);
  assert.deepEqual(completed.annotations, [], 'the removed current-run candidate is not returned or resurrected');
  assert.equal(completed.annotationOperations.find((operation) => operation.operation === 'delete')?.status, 'approved');
});

test('rejecting an annotation update records the decision without applying it', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reject-mutation-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-mutation-inspect' })]),
    modelResponse([functionCall('update_annotation', {
      annotationId: 'existing-note', label: 'HIGH RISK', note: 'Change this label.', reason: 'The original classification appears too low.',
    }, { callId: 'reject-mutation-update' })]),
    modelResponse([assistantMessage('The proposed update was rejected and the annotation remains unchanged.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Review this existing annotation.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Source evidence.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
    existingAnnotations: [{ id: 'existing-note', pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, label: 'MEDIUM RISK', note: 'Existing label.', status: 'active' }],
  }, model);
  assert.equal(paused.status, 'interrupted');
  const rejected = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: false, note: 'The original label is supported.' });
  model.assertComplete();
  assert.equal(rejected.status, 'complete');
  assert.equal(rejected.annotationOperations?.[0]?.status, 'rejected');
  assert.equal(rejected.annotationOperations?.[0]?.existingLabel, 'MEDIUM RISK');
});

test('the agent navigates to a searched page, receives its image, and targets the annotation there', async () => {
  const adapter = new PagedDocumentAdapter('contract.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [
      { number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Definitions</text></svg>' },
      { number: 2, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Termination for convenience</text></svg>' },
    ],
  } as unknown as PreviewReport);
  const model = new ScriptedModel([
    modelResponder((call) => {
      const initialContext = JSON.stringify(call.request.input);
      assert.match(initialContext, /This is a full-document run over 2 pages/);
      assert.doesNotMatch(initialContext, /Current human-visible page bounds/);
      return [functionCall('get_document_outline', {}, { callId: 'nav-outline' })];
    }),
    modelResponder((call) => {
      const outline = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'get_document_outline')
        : undefined;
      assert.ok(outline, 'the full-document outline returns to the Agent');
      const raw = 'output' in outline ? outline.output : undefined;
      const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && !Array.isArray(raw) && 'text' in raw ? String(raw.text) : '';
      const result = JSON.parse(text) as { currentViewport: { x: number; y: number; width: number; height: number } };
      assert.deepEqual(result.currentViewport, { x: 0, y: 0, width: 1, height: 1 });
      return [functionCall('inspect_page', {}, { callId: 'nav-inspect-start' })];
    }),
    modelResponse([functionCall('search_document', { query: 'termination' }, { callId: 'nav-search' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The termination clause search hit is on this page.' }, { callId: 'nav-open-page-2' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'nav-inspect-page-2' })]),
    modelResponse([functionCall('annotate_region', {
      x: 0.1, y: 0.12, width: 0.6, height: 0.12,
      label: 'HIGH RISK', note: 'One-sided termination right.', reason: 'The clause gives one party unilateral termination.',
      excerpt: 'Termination for convenience', confidence: null, reviewPriority: 'low', requiresReview: false,
    }, { callId: 'nav-annotate-page-2' })]),
    modelResponse([assistantMessage('The clause was found on page 2 and annotated there.')]),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find all termination clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Definitions.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2,
    documentAdapters: [adapter], allowNavigation: true, mode: 'assist', viewerAspectRatio: 1.5,
    viewerViewport: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.annotations[0]?.pageNumber, 2);
  assert.deepEqual(result.visitedPages, [1, 2]);
  assert.equal(result.toolEvents.find((event) => event.toolName === 'navigate_page')?.pageNumber, 2);
  assert.equal(adapter.listAnnotations()[0]?.target.kind, 'page');
  assert.equal(adapter.listAnnotations()[0]?.status, 'auto');
  assert.equal(adapter.listAnnotations()[0]?.evidence, 'Termination for convenience');
});

test('the Agent can inspect more than twelve distinct pages in one bounded-context RunState', async () => {
  const totalPages = 40;
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const pageNumber = index + 1;
    const complexVisual = pageNumber === totalPages
      ? Array.from({ length: 1000 }, (_, shapeIndex) => {
        const x = (shapeIndex * 37) % 1500;
        const y = (shapeIndex * 83) % 2000;
        const color = ((shapeIndex * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0');
        return `<rect x="${x}" y="${y}" width="38" height="30" fill="#${color}"/>`;
      }).join('')
      : '';
    const svg = pageNumber === totalPages
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="2000"><rect width="1500" height="2000" fill="#fff"/>${complexVisual}<text x="80" y="120">Page ${pageNumber} distinct evidence block.</text></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><text x="40" y="80">Page ${pageNumber} distinct evidence block.</text></svg>`;
    return { number: pageNumber, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg };
  });
  const adapter = new PagedDocumentAdapter('long-document.pdf', {
    sourceFormat: 'PDF', pageCount: totalPages, pages,
  } as unknown as PreviewReport, 'long-document');
  const responses: ScriptedModelInput[] = [
    modelResponse([functionCall('get_document_outline', {}, { callId: 'long-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'long-inspect-first' })]),
  ];
  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    responses.push(modelResponse([functionCall('navigate_page', { pageNumber, reason: `Review page ${pageNumber} to verify complete-document coverage.` }, { callId: `long-open-${pageNumber}` })]));
    responses.push(modelResponder(async (call) => {
      const navigationResult = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'navigate_page')
        : undefined;
      assert.ok(navigationResult, `page ${pageNumber} navigation output should be available to the next Agent turn`);
      const navigationPayload = JSON.stringify(navigationResult);
      assert.match(navigationPayload, /image\/jpeg/u);
      assert.match(navigationPayload, /"detail":"low"/u);
      assert.ok(navigationPayload.length < 200_000, `page ${pageNumber} overview payload should stay bounded (${navigationPayload.length} JSON characters)`);
      const encodedImage = navigationPayload.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/u)?.[1];
      assert.ok(encodedImage, `page ${pageNumber} low-detail overview image was missing`);
      const imageBuffer = Buffer.from(encodedImage, 'base64');
      const imageMetadata = await sharp(imageBuffer).metadata();
      assert.ok(imageBuffer.byteLength <= 48 * 1024, `page ${pageNumber} overview image exceeded the per-page byte budget (${imageBuffer.byteLength} bytes)`);
      assert.ok((imageMetadata.width ?? 0) <= 1024 && (imageMetadata.height ?? 0) <= 1024, 'navigation overview dimensions should be bounded');
      if (pageNumber === totalPages) assert.ok((imageMetadata.width ?? 1024) < 1024, 'a visually dense page should downscale until it fits the image-byte budget');
      return [functionCall('inspect_page', {}, { callId: `long-inspect-${pageNumber}` })];
    }));
  }
  responses.push(modelResponse([assistantMessage('I inspected all forty pages within this Agent run.') ]));
  const model = new ScriptedModel(responses);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page and find all evidence blocks.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 1 distinct evidence block.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages,
    documentId: 'long-document', documentAdapters: [adapter], allowNavigation: true, mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.visitedPages, Array.from({ length: totalPages }, (_, index) => index + 1));
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'navigate_page').length, totalPages - 1);
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'inspect_page').length, totalPages);
  assert.equal(result.toolEvents.at(-1)?.toolName, 'inspect_page');
});

test('the Agent outline caps per-page heading details and total page entries', async () => {
  const totalPages = 121;
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const pageNumber = index + 1;
    const body = Array.from({ length: 13 }, (_, row) => `<text x="20" y="${30 + row * 12}" font-size="10">body text ${pageNumber} ${row}.</text>`).join('');
    const headings = Array.from({ length: 12 }, (_, row) => `<text x="20" y="${240 + row * 18}" font-size="20" font-weight="bold">Heading ${pageNumber} ${row}</text>`).join('');
    return { number: pageNumber, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792">${body}${headings}</svg>` };
  });
  const adapter = new PagedDocumentAdapter('very-long-document.pdf', {
    sourceFormat: 'PDF', pageCount: totalPages, pages,
  } as unknown as PreviewReport, 'very-long-document');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'bounded-outline' })]),
    modelResponder((call) => {
      const outlineResult = Array.isArray(call.request.input)
        ? call.request.input.find((item) => item.type === 'function_call_result' && item.name === 'get_document_outline')
        : undefined;
      assert.ok(outlineResult);
      const raw = 'output' in outlineResult ? outlineResult.output : undefined;
      const outputText = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && !Array.isArray(raw) && 'text' in raw ? String(raw.text) : '';
      const parsed = JSON.parse(outputText) as { documentAdapters: Array<{ pageCount: number; pageListTruncated?: boolean; pages: Array<{ headingCandidates?: unknown[] }> }> };
      const pagedOutline = parsed.documentAdapters[0]!;
      assert.equal(pagedOutline.pageCount, totalPages);
      assert.equal(pagedOutline.pages.length, 120);
      assert.equal(pagedOutline.pageListTruncated, true);
      assert.ok(pagedOutline.pages.every((page) => (page.headingCandidates?.length ?? 0) <= 1));
      assert.ok(outputText.length < 60_000, `the long-document outline should be bounded (${outputText.length} characters)`);
      return [functionCall('inspect_page', {}, { callId: 'bounded-outline-inspect' })];
    }),
    modelResponse([assistantMessage('The outline stays bounded for long documents.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page for safety requirements.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Opening page text.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages, documentId: 'very-long-document', documentAdapters: [adapter], allowNavigation: true, mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.inspectedPages, [1]);
  assert.deepEqual(result.remainingPages, Array.from({ length: 120 }, (_, index) => index + 2));
});

test('a navigation-only page remains in the server-reported full-document remainder', async () => {
  const adapter = new PagedDocumentAdapter('opened-only.pdf', {
    sourceFormat: 'PDF', pageCount: 3,
    pages: [1, 2, 3].map((number) => ({ number, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Page ${number}</text></svg>` })),
  } as unknown as PreviewReport, 'opened-only');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'opened-only-outline' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 3, reason: 'The end of the document might contain a relevant clause.' }, { callId: 'opened-only-navigation' })]),
    modelResponse([assistantMessage('I opened the final page and finished early.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page for the requested evidence.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 1', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 3, requestedScope: 'all', documentId: 'opened-only', documentAdapters: [adapter], allowNavigation: true, mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.visitedPages, [1, 3]);
  assert.deepEqual(result.inspectedPages, [1]);
  assert.deepEqual(result.remainingPages, [2, 3]);
});

test('a full-scope export stays disabled when a segmented checkpoint is incomplete', async () => {
  const adapter = new PagedDocumentAdapter('incomplete-export.pdf', {
    sourceFormat: 'PDF', pageCount: 3,
    pages: [1, 2, 3].map((number) => ({ number, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Page ${number}</text></svg>` })),
  } as unknown as PreviewReport, 'incomplete-export');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'incomplete-export-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'incomplete-export-inspect-last' })]),
    modelResponse([functionCall('export_annotations', { format: 'annotations-json' }, { callId: 'incomplete-export-premature' })]),
    modelResponse([assistantMessage('The current segment is done, but page 2 remains.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect the remaining page and export JSON after full coverage.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 3', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 3, totalPages: 3, requestedScope: 'all', alreadyInspectedPages: [1],
    documentId: 'incomplete-export', documentAdapters: [adapter], allowNavigation: false, exportRequested: true, mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.remainingPages, [2]);
  assert.equal(result.exports.length, 0, 'a later page alone must not satisfy the full-document export gate');
});

test('the agent can search, navigate, pause, and resume on an 80-page document', async () => {
  const pages = Array.from({ length: 80 }, (_, index) => {
    const pageNumber = index + 1;
    const text = pageNumber === 80 ? 'Either party may terminate without cause.' : `Page ${pageNumber} general terms.`;
    return { number: pageNumber, widthPoints: 612, heightPoints: 792, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><text x="40" y="80">${text}</text></svg>` };
  });
  const adapter = new PagedDocumentAdapter('80-page-contract.pdf', {
    sourceFormat: 'PDF', pageCount: pages.length, pages,
  } as unknown as PreviewReport, '80-page-contract');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'long-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'long-inspect-first' })]),
    modelResponse([functionCall('search_document', { query: 'terminate' }, { callId: 'long-search-termination' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 80, reason: 'The termination search result is on the final page.' }, { callId: 'long-navigate-final' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'long-inspect-final' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.1, width: 0.55, height: 0.06, label: 'HIGH RISK', note: 'Either party can terminate without cause.',
      reason: 'The clause is important but needs a human decision about its business impact.', excerpt: 'Either party may terminate without cause.',
      confidence: null, reviewPriority: 'high', requiresReview: true,
    }, { callId: 'long-final-review' })]),
    modelResponse([assistantMessage('I completed the long-document pass after the reviewer resolved the final-page issue.')]),
  ]);

  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find and classify every termination clause.',
    guidelines: 'Escalate clauses whose business impact needs a human decision.', correction: '', humanDecisions: '',
    pageText: 'Page 1 general terms.', imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 80,
    documentId: '80-page-contract', documentAdapters: [adapter], allowNavigation: true, mode: 'autopilot',
  }, model);
  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.annotations[0]?.pageNumber, 80);
  assert.deepEqual(paused.visitedPages, [1, 80]);
  assert.match(paused.toolEvents.find((event) => event.toolName === 'search_document')?.detail ?? '', /found 1 text or cell matches/);

  const completed = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'incomplete');
  assert.deepEqual(completed.remainingPages, Array.from({ length: 78 }, (_, index) => index + 2));
  assert.equal(completed.inspectedPages?.length, 2, 'the same RunState preserves its inspected-page checkpoint through approval');
  const stored = adapter.listAnnotations()[0]!;
  assert.equal(stored.target.kind, 'page');
  assert.equal(stored.status, 'approved');
  if (stored.target.kind === 'page') assert.equal(stored.target.page, 80);
});

test('the Agent waits for the full scope and review before exporting through its adapter tool', async () => {
  assert.equal(isExplicitExportRequest('Find termination clauses and export the annotated PDF.'), true);
  assert.equal(isExplicitExportRequest('Find termination clauses, but do not export anything.'), false);
  assert.equal(isExplicitExportRequest('Do not export until the final human review is complete.'), true);
  assert.equal(isExplicitExportRequest('条項を確認して、結果をJSONで保存してください。'), true);

  const adapter = new PagedDocumentAdapter('review.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [1, 2].map((number) => ({ number, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">${number === 1 ? 'Termination for convenience' : 'Definitions'}</text></svg>` })),
  } as unknown as PreviewReport, 'export-doc-1');
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'export-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'export-inspect' })]),
    modelResponse([functionCall('request_review', {
      x: 0.1, y: 0.15, width: 0.55, height: 0.1, label: 'TERMINATION', note: 'Unilateral termination right.',
      reason: 'The clause allows termination without cause.', excerpt: 'Termination for convenience',
      confidence: 0.9, reviewPriority: 'medium', requiresReview: true,
    }, { callId: 'export-review' })]),
    modelResponse([functionCall('export_annotations', { format: 'native-annotated' }, { callId: 'export-too-early' })]),
    modelResponse([functionCall('navigate_page', { pageNumber: 2, reason: 'The requested document scope includes the remaining definitions page.' }, { callId: 'export-navigate-last' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'export-inspect-last' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'export-validator' })]),
    modelResponse([functionCall('export_annotations', { format: 'native-annotated' }, { callId: 'export-request' })]),
    modelResponse([assistantMessage('The annotated PDF is ready for download.')]),
  ]);
  const validatorModel = new ScriptedModel([modelResponse([assistantMessage(JSON.stringify({ findings: [
    { kind: 'evidence_gap', annotationIds: ['export-review'], title: 'Confirm the supporting evidence', reason: 'The clause is important and should be checked by a human reviewer.', reviewPriority: 'medium' },
  ] }))])]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find termination clauses and export the annotated PDF.',
    guidelines: 'Use visible evidence.', correction: '', humanDecisions: '', pageText: 'Termination for convenience',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2, documentId: 'export-doc-1',
    documentAdapters: [adapter], mode: 'assist', allowNavigation: true, requestedScope: 'all',
  }, model, validatorModel);

  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.exports.length, 0);
  const result = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.visitedPages, [2], 'resume reports the newly inspected page only');
  assert.equal(adapter.listAnnotations()[0]?.status, 'approved');
  assert.equal(result.exports.length, 1);
  const artifact = result.exports[0]!;
  assert.equal(artifact.fileName, 'review-annotated.pdf');
  assert.equal(artifact.snapshotSignature, result.validator?.snapshotSignature);
  assert.equal('buffer' in artifact, false);
  assert.equal(result.validator?.status, 'complete');
  assert.equal(result.validator?.findings[0]?.kind, 'evidence_gap');
  assert.equal(result.validator?.findings[0]?.annotationIds[0], 'export-review');
  const finalValidatorIndex = result.toolEvents.findIndex((event) => event.toolName === 'validate_annotations' && event.status === 'complete');
  const preparedExportIndex = result.toolEvents.findIndex((event) => event.toolName === 'export_annotations' && event.status === 'complete' && /ready for download/.test(event.detail));
  assert.ok(finalValidatorIndex > result.toolEvents.findIndex((event) => event.toolName === 'inspect_page' && event.pageNumber === 2));
  assert.ok(preparedExportIndex > finalValidatorIndex, 'the Validator result must precede the deterministic exporter');
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'export_annotations' && event.status === 'complete').length, 1, 'the premature export call is hidden until every page is inspected; only the final export emits completion');
  const stored = await agentExportStore.get(artifact.id);
  assert.match(stored?.buffer.toString('latin1', 0, 8) ?? '', /^%PDF-/);
  assert.equal(stored?.descriptor.documentId, 'export-doc-1');
  validatorModel.assertComplete();
});

test('a later navigation segment inherits prior inspected pages for the full-document export gate', async () => {
  const documentId = 'segmented-export-doc';
  const adapter = new PagedDocumentAdapter('segmented.pdf', {
    sourceFormat: 'PDF', pageCount: 3,
    pages: [1, 2, 3].map((number) => ({ number, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Page ${number}</text></svg>` })),
  } as unknown as PreviewReport, documentId);
  adapter.annotate({
    id: 'segment-approved-finding', documentId,
    target: { kind: 'page', page: 2, boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } },
    label: 'REVIEWED', evidence: 'Page 2', explanation: 'Prior segment finding.',
    reviewPriority: 'low', status: 'approved', excerpt: 'Page 2',
  });
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'segment-export-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'segment-export-inspect-last' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'segment-export-validator' })]),
    modelResponse([functionCall('export_annotations', { format: 'native-annotated' }, { callId: 'segment-export-final' })]),
    modelResponse([assistantMessage('The final segment completed the full-document export.')]),
  ]);
  const validatorModel = new ScriptedModel([modelResponse([assistantMessage(JSON.stringify({ findings: [
    { kind: 'unsupported_claim', annotationIds: ['segment-approved-finding'], title: 'Review the support for this label', reason: 'Check that the supplied page evidence supports the classification.', reviewPriority: 'low' },
  ] }))])]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Review the remaining page and export the completed document.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 3', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 3, totalPages: 3, requestedScope: 'all', alreadyInspectedPages: [1, 2],
    documentId, documentAdapters: [adapter], allowNavigation: true, exportRequested: true, mode: 'observe',
  }, model, validatorModel);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.exports.length, 1, 'the prior-segment checkpoint should let the final inspected page complete export scope');
  assert.equal(result.exports[0]?.fileName, 'segmented-annotated.pdf');
  assert.equal(result.validator?.status, 'complete');
  assert.equal(result.validator?.findings[0]?.kind, 'unsupported_claim');
  assert.ok(result.toolEvents.findIndex((event) => event.toolName === 'validate_annotations' && event.status === 'complete') < result.toolEvents.findIndex((event) => event.toolName === 'export_annotations' && event.status === 'complete'));
  assert.equal(adapter.listAnnotations()[0]?.status, 'approved', 'the read-only Validator never changes the human-approved annotation');
  validatorModel.assertComplete();
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'export_annotations' && event.status === 'complete').length, 1);
});

test('the export gate invalidates a Validator result when the annotation snapshot changes', async () => {
  const documentId = 'validator-snapshot-change';
  const adapter = new PagedDocumentAdapter('snapshot-change.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Either party may terminate without cause.</text></svg>' }],
  } as unknown as PreviewReport, documentId);
  adapter.annotate({
    id: 'stable-existing', documentId,
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.08 } },
    label: 'REVIEWED', evidence: 'Either party may terminate without cause.', explanation: 'Existing annotation.',
    reviewPriority: 'medium', status: 'auto', excerpt: 'Either party may terminate without cause.', reason: 'Existing annotation.', note: 'Existing annotation.',
  });

  let firstSignature = '';
  let finalSignature = '';
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'snapshot-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'snapshot-inspect' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'snapshot-validator-first' })]),
    modelResponder((call) => {
      firstSignature = String(readToolResult(call, 'validate_annotations').snapshotSignature);
      return [functionCall('annotate_region', {
      x: 0.1, y: 0.3, width: 0.5, height: 0.08, label: 'HIGH RISK', note: 'Unilateral termination right.',
      reason: 'Either party can terminate without cause.', excerpt: 'Either party may terminate without cause.',
      confidence: 0.8, reviewPriority: 'low', requiresReview: false,
      }, { callId: 'snapshot-change-annotation' })];
    }),
    modelResponse([functionCall('export_annotations', { format: 'annotations-json' }, { callId: 'snapshot-export-stale' })]),
    modelResponder((call) => {
      const blockedExport = readToolResult(call, 'export_annotations');
      assert.equal(blockedExport.prepared, false);
      assert.equal(blockedExport.validatorRequired, true);
      assert.equal(blockedExport.validatorStatus, 'not_run');
      assert.notEqual(blockedExport.snapshotSignature, firstSignature, 'adding an annotation changes the signature required for export');
      return [functionCall('validate_annotations', {}, { callId: 'snapshot-validator-second' })];
    }),
    modelResponder((call) => {
      const checked = readToolResult(call, 'validate_annotations');
      assert.equal(checked.status, 'complete');
      finalSignature = String(checked.snapshotSignature);
      assert.notEqual(finalSignature, firstSignature, JSON.stringify({ firstSignature, finalSignature }));
      return [functionCall('export_annotations', { format: 'annotations-json' }, { callId: 'snapshot-export' })];
    }),
    modelResponse([assistantMessage('The changed annotation snapshot was checked before export.')]),
  ]);
  const validatorModel = new ScriptedModel([
    modelResponse([assistantMessage(JSON.stringify({ findings: [
      { kind: 'evidence_gap', annotationIds: ['stable-existing'], title: 'Check source support', reason: 'Verify the evidence for this existing label.', reviewPriority: 'low' },
    ] }))]),
    modelResponse([assistantMessage(JSON.stringify({ findings: [
      { kind: 'unsupported_claim', annotationIds: ['stable-existing'], title: 'Review the updated set', reason: 'The latest document-wide snapshot should be reviewed by a person.', reviewPriority: 'medium' },
    ] }))]),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page and export the annotated results as JSON.',
    guidelines: 'Use visible evidence.', correction: '', humanDecisions: '', pageText: 'Either party may terminate without cause.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, requestedScope: 'all',
    exportRequested: true, documentId, documentAdapters: [adapter], allowNavigation: true, mode: 'autopilot',
  }, model, validatorModel);

  model.assertComplete();
  validatorModel.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.exports.length, 1);
  assert.equal(result.validator?.status, 'complete');
  assert.equal(result.validator?.snapshotSignature, finalSignature);
  assert.equal(adapter.listAnnotations().find((annotation) => annotation.id === 'stable-existing')?.status, 'auto', 'Validator findings never approve or alter existing annotations');
  assert.equal(adapter.listAnnotations().find((annotation) => annotation.label === 'HIGH RISK')?.status, 'auto', 'Validator findings never approve or alter new annotations');
  const validatorCompletions = result.toolEvents.filter((event) => event.toolName === 'validate_annotations' && event.status === 'complete');
  assert.equal(validatorCompletions.length, 2, 'the changed snapshot requires another read-only validation');
  const finalValidatorIndex = result.toolEvents.findIndex((event) => event.toolName === 'validate_annotations' && event.status === 'complete' && event.detail.includes('1 finding'));
  const exporterIndex = result.toolEvents.findIndex((event) => event.toolName === 'export_annotations' && event.status === 'complete' && event.detail.includes('ready for download'));
  assert.ok(exporterIndex > finalValidatorIndex, 'the second Validator result must precede deterministic JSON export');
});

test('a validated snapshot is memoized across persisted approval retries when that snapshot remains unchanged', async () => {
  const documentId = 'validator-cache-approval';
  const adapter = new PagedDocumentAdapter('validator-cache.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Reviewed clause.</text></svg>' }],
  } as unknown as PreviewReport, documentId);
  adapter.annotate({
    id: 'cache-stable', documentId,
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.08 } },
    label: 'REVIEWED', evidence: 'Reviewed clause.', explanation: 'Original annotation.',
    reviewPriority: 'low', status: 'auto', excerpt: 'Reviewed clause.', reason: 'Original annotation.', note: 'Original annotation.',
  });
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'validator-cache-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'validator-cache-inspect' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'validator-cache-first' })]),
    modelResponse([functionCall('update_annotation', {
      annotationId: 'cache-stable', label: 'UPDATED', note: 'Proposed change.', reason: 'Ask before changing the saved annotation.',
    }, { callId: 'validator-cache-update' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'validator-cache-retry' })]),
    modelResponse([functionCall('export_annotations', { format: 'native-annotated' }, { callId: 'validator-cache-export' })]),
    modelResponse([assistantMessage('The unchanged snapshot reused its persisted Validator result.')]),
  ]);
  const validatorModel = new ScriptedModel([modelResponse([assistantMessage(JSON.stringify({ findings: [
    { kind: 'evidence_gap', annotationIds: ['cache-stable'], title: 'Confirm the source support', reason: 'A person should confirm this saved label.', reviewPriority: 'low' },
  ] }))])]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect the full document, validate it, and export the annotated PDF.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Reviewed clause.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 1, requestedScope: 'all', exportRequested: true, documentId,
    documentAdapters: [adapter], existingAnnotations: [{ id: 'cache-stable', pageNumber: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.08, label: 'REVIEWED', note: 'Original annotation.', excerpt: 'Reviewed clause.', reviewPriority: 'low', status: 'active' }],
    allowNavigation: true, mode: 'assist',
  }, model, validatorModel);

  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.validator?.status, 'complete');
  const persisted = await pendingRunStore.get<{ validatorState?: { cache?: Record<string, unknown> } }>('pending-agent-runs', paused.approvalRunId!);
  assert.ok(persisted?.validatorState?.cache?.[paused.validator!.snapshotSignature], 'approval persistence includes the result keyed by the validated snapshot signature');
  const resumed = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: false, note: 'Keep the current annotation.' });

  model.assertComplete();
  validatorModel.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.exports.length, 1);
  assert.equal(resumed.validator?.status, 'complete');
  assert.equal(adapter.listAnnotations()[0]?.label, 'REVIEWED');
  const validatorResults = resumed.toolEvents.filter((event) => event.toolName === 'validate_annotations' && event.status === 'complete');
  assert.equal(validatorResults.length, 1);
  assert.match(validatorResults[0]?.detail ?? '', /Reused the read-only Validator result/);
});

test('a failed Validator result blocks visual export instead of silently proceeding', async () => {
  const documentId = 'validator-export-failure';
  const adapter = new PagedDocumentAdapter('validator-failure.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Reviewed clause.</text></svg>' }],
  } as unknown as PreviewReport, documentId);
  adapter.annotate({
    id: 'validator-failure-annotation', documentId,
    target: { kind: 'page', page: 1, boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.08 } },
    label: 'REVIEWED', evidence: 'Reviewed clause.', explanation: 'Saved finding.',
    reviewPriority: 'low', status: 'auto', excerpt: 'Reviewed clause.', reason: 'Saved finding.', note: 'Saved finding.',
  });
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'validator-failure-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'validator-failure-inspect' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'validator-failure-run' })]),
    modelResponse([functionCall('export_annotations', { format: 'annotations-json' }, { callId: 'validator-failure-export' })]),
    modelResponse([assistantMessage('The Validator could not verify this snapshot, so no export was prepared.')]),
  ]);
  const validatorModel = new ScriptedModel([modelResponse([assistantMessage(JSON.stringify({ findings: 'invalid' }))])]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page, validate the results, and export JSON.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Reviewed clause.', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 1, requestedScope: 'all', exportRequested: true,
    documentId, documentAdapters: [adapter], allowNavigation: true, mode: 'observe',
  }, model, validatorModel);

  model.assertComplete();
  validatorModel.assertComplete();
  assert.equal(result.validator?.status, 'failed');
  assert.match(result.validator?.error ?? '', /export remains blocked/);
  assert.equal(result.exports.length, 0);
  assert.ok(result.toolEvents.some((event) => event.toolName === 'export_annotations' && event.detail.includes('Validator failed')));
  assert.equal(result.toolEvents.some((event) => event.toolName === 'export_annotations' && event.detail.includes('ready for download')), false);
});

test('the Validator is not called when full-document coverage is incomplete or a full-document export was not requested', async () => {
  const incompleteAdapter = new PagedDocumentAdapter('incomplete-validator.pdf', {
    sourceFormat: 'PDF', pageCount: 2,
    pages: [1, 2].map((number) => ({ number, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Page ${number}</text></svg>` })),
  } as unknown as PreviewReport, 'incomplete-validator-doc');
  const incompleteValidator = new ScriptedModel([]);
  const incompleteModel = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'incomplete-validator-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'incomplete-validator-inspect' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'incomplete-validator-attempt' })]),
    modelResponse([assistantMessage('The other page remains uninspected.')]),
  ]);
  const incomplete = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Inspect every page and export the visual document.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 1', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 2, requestedScope: 'all', exportRequested: true, documentId: 'incomplete-validator-doc',
    documentAdapters: [incompleteAdapter], allowNavigation: true, mode: 'observe',
  }, incompleteModel, incompleteValidator);
  incompleteModel.assertComplete();
  incompleteValidator.assertComplete();
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.validator?.status, 'not_run');
  assert.equal(incomplete.toolEvents.some((event) => event.toolName === 'validate_annotations'), false);

  const noExportAdapter = new PagedDocumentAdapter('no-export-validator.pdf', {
    sourceFormat: 'PDF', pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><text x="4" y="20">Page 1</text></svg>' }],
  } as unknown as PreviewReport, 'no-export-validator-doc');
  const noExportValidator = new ScriptedModel([]);
  const noExportModel = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'no-export-validator-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'no-export-validator-inspect' })]),
    modelResponse([functionCall('validate_annotations', {}, { callId: 'no-export-validator-attempt' })]),
    modelResponse([assistantMessage('The full document was reviewed without an export request.')]),
  ]);
  const noExport = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'low', instruction: 'Review every page for termination clauses.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Page 1', imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1, totalPages: 1, requestedScope: 'all', exportRequested: false, documentId: 'no-export-validator-doc',
    documentAdapters: [noExportAdapter], allowNavigation: true, mode: 'observe',
  }, noExportModel, noExportValidator);
  noExportModel.assertComplete();
  noExportValidator.assertComplete();
  assert.equal(noExport.status, 'complete');
  assert.equal(noExport.validator?.status, 'not_run');
  assert.equal(noExport.toolEvents.some((event) => event.toolName === 'validate_annotations'), false);
});
