import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ScriptedModel, assistantMessage, functionCall, modelResponder, modelResponse } from '@openai/agents/testing';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDocumentExportStoreForTests, configurePendingAgentRunStoreForTests, getPendingAgentRunInfo, isExplicitExportRequest, restorePendingAgentRun, resumeDocumentAgentRun, runDocumentAgent } from './documentAgent';
import { SpreadsheetDocumentAdapter } from './spreadsheetAdapter';
import { PagedDocumentAdapter } from './documentAdapter';
import { createPrivateRecordStore } from './privateRecordStore';
import { createDocumentExportStore } from './documentExportStore';
import type { PreviewReport } from 'document-svg';

let persistenceDirectory = '';
let agentExportStore: ReturnType<typeof createDocumentExportStore>;
before(async () => {
  persistenceDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-agent-tests-'));
  const store = createPrivateRecordStore(persistenceDirectory);
  configurePendingAgentRunStoreForTests(store);
  agentExportStore = createDocumentExportStore(store);
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

test('high review priority requires human review regardless of the optional numeric estimate', async () => {
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

test('restores an encrypted pending RunState and continues after a worker restart', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'restore-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'restore-inspect' })]),
    modelResponse([functionCall('request_review', {
      x: 0.25, y: 0.3, width: 0.35, height: 0.12,
      label: 'Needs review', note: 'Review after restart.', reason: 'The statement has an unclear qualification.',
      excerpt: 'unclear qualification', reviewPriority: 'high', requiresReview: true,
    }, { callId: 'restore-review' })]),
    modelResponse([assistantMessage('The approved finding was processed after restoring the saved run.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find statements needing review.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'A statement with an unclear qualification.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1, mode: 'assist',
    documentId: 'versioned-document-session', sourceHash: 'a'.repeat(64),
  }, model);
  assert.equal(paused.status, 'interrupted');
  assert.ok(paused.approvalRunId);
  assert.equal((await getPendingAgentRunInfo(paused.approvalRunId!))?.sourceHash, 'a'.repeat(64));

  const restored = await restorePendingAgentRun({
    runId: paused.approvalRunId!, providerName: 'openai-api', forceRestore: true, testModel: model,
  });
  assert.equal(restored, true);
  const resumed = await resumeDocumentAgentRun({ runId: paused.approvalRunId!, approvalId: paused.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.annotations.length, 0);
  assert.equal(await getPendingAgentRunInfo(paused.approvalRunId!), null, 'completed restored runs remove their durable checkpoint');
});

test('concurrent duplicate approvals cannot apply the same workbook mutation twice', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'duplicate-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'duplicate-inspect' })]),
    modelResponse([functionCall('get_workbook_outline', {}, { callId: 'duplicate-workbook' })]),
    modelResponse([functionCall('inspect_sheet', { sheetName: 'Customers' }, { callId: 'duplicate-sheet' })]),
    modelResponse([functionCall('read_range', { sheetName: 'Customers', range: 'A1:B2' }, { callId: 'duplicate-range' })]),
    modelResponse([functionCall('write_cell', {
      sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'The evidence supports a high-risk label.', confidence: 0.9, reviewPriority: 'medium',
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
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'xlsx-inspect' })]),
    modelResponse([functionCall('get_workbook_outline', {}, { callId: 'xlsx-workbook' })]),
    modelResponse([functionCall('inspect_sheet', { sheetName: 'Customers' }, { callId: 'xlsx-sheet' })]),
    modelResponse([functionCall('read_range', { sheetName: 'Customers', range: 'A1:B5' }, { callId: 'xlsx-range' })]),
    modelResponse([functionCall('search_document', { query: 'Mina' }, { callId: 'xlsx-global-search' })]),
    modelResponse([functionCall('create_column', { sheetName: 'Customers', header: 'Churn Risk', headerRow: 3, reason: 'Add a column for risk labels beside the customer table.', reviewPriority: 'medium' }, { callId: 'xlsx-column' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'C4', value: 'LOW', reason: 'No support tickets indicate low risk.', confidence: 0.94, reviewPriority: 'low' }, { callId: 'xlsx-cell' })]),
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
  assert.equal(adapter.readRange('Customers', 'C3').rows[0]?.[0]?.value, null);

  const pausedCell = await resumeDocumentAgentRun({ runId: pausedColumn.approvalRunId!, approvalId: pausedColumn.approvalId!, approved: true });
  assert.equal(pausedCell.status, 'interrupted');
  assert.equal(pausedCell.spreadsheetChanges?.find((change) => change.id === pausedColumn.approvalId)?.approved, true);
  assert.equal(adapter.readRange('Customers', 'A1').rows[0]?.[0]?.value, 'Customer churn review');
  assert.equal(adapter.readRange('Customers', 'C1').rows[0]?.[0]?.value, null);
  assert.equal(adapter.readRange('Customers', 'C3').rows[0]?.[0]?.value, 'Churn Risk');
  assert.equal(adapter.readRange('Customers', 'C4').rows[0]?.[0]?.value, null);

  const completed = await resumeDocumentAgentRun({ runId: pausedCell.approvalRunId!, approvalId: pausedCell.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.spreadsheetChanges?.find((change) => change.id === pausedCell.approvalId)?.approved, true);
  assert.equal(adapter.readRange('Customers', 'C4').rows[0]?.[0]?.value, 'LOW');
});

test('rejecting an Excel cell write resumes the same RunState and leaves the workbook unchanged', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'reject-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'reject-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'Recent activity indicates high risk.', confidence: 0.92, reviewPriority: 'high' }, { callId: 'reject-xlsx-cell' })]),
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
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, null);
});

test('batch mode writes workbook changes without pausing between documents', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'batch-xlsx-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'batch-xlsx-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'LOW', reason: 'The row shows recent activity and no support cases.', confidence: 0.93, reviewPriority: 'low' }, { callId: 'batch-xlsx-cell' })]),
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

test('batch mode preserves qualitative review priority while continuing the workbook write', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Customers').addRows([['Name', 'Risk'], ['Aki', null]]);
  const adapter = await SpreadsheetDocumentAdapter.fromBuffer('customers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const model = new ScriptedModel([
    modelResponse([functionCall('get_document_outline', {}, { callId: 'batch-review-outline' })]),
    modelResponse([functionCall('inspect_page', {}, { callId: 'batch-review-inspect' })]),
    modelResponse([functionCall('write_cell', { sheetName: 'Customers', address: 'B2', value: 'HIGH', reason: 'The evidence is incomplete.', confidence: null, reviewPriority: 'high' }, { callId: 'batch-review-write' })]),
    modelResponse([assistantMessage('The high-priority item is staged for human review.')]),
  ]);
  const result = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Classify customer risk.',
    guidelines: '', correction: '', humanDecisions: '', pageText: 'Aki customer row.',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 1,
    mode: 'assist', requireToolApproval: false, spreadsheet: adapter,
  }, model);
  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(result.spreadsheetChanges?.[0]?.requiresReview, false);
  assert.equal(result.spreadsheetChanges?.[0]?.reviewPriority, 'high');
  assert.equal(result.spreadsheetChanges?.[0]?.approved, true);
  assert.equal(adapter.readRange('Customers', 'B2').rows[0]?.[0]?.value, 'HIGH');
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
  assert.equal(result.status, 'complete');
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

  const completed = await resumeDocumentAgentRun({ runId: second.approvalRunId!, approvalId: second.approvalId!, approved: true });
  model.assertComplete();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.annotationOperations?.find((item) => item.operation === 'delete')?.status, 'approved');
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
    modelResponse([functionCall('export_annotations', { format: 'native-annotated' }, { callId: 'export-request' })]),
    modelResponse([assistantMessage('The annotated PDF is ready for download.')]),
  ]);
  const paused = await runDocumentAgent({
    model: 'gpt-6-astra', reasoningEffort: 'medium', instruction: 'Find termination clauses and export the annotated PDF.',
    guidelines: 'Use visible evidence.', correction: '', humanDecisions: '', pageText: 'Termination for convenience',
    imageDataUrl: 'data:image/png;base64,AA==', pageNumber: 1, totalPages: 2, documentId: 'export-doc-1',
    documentAdapters: [adapter], mode: 'assist', allowNavigation: true, requestedScope: 'all',
  }, model);

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
  assert.equal('buffer' in artifact, false);
  assert.equal(result.toolEvents.filter((event) => event.toolName === 'export_annotations').length, 2, 'the premature export call is hidden until every page has been inspected; the final call emits start and completion events');
  assert.match(result.toolEvents.find((event) => event.toolName === 'export_annotations' && event.status === 'complete')?.detail ?? '', /ready for download/);
  const stored = await agentExportStore.get(artifact.id);
  assert.match(stored?.buffer.toString('latin1', 0, 8) ?? '', /^%PDF-/);
  assert.equal(stored?.descriptor.documentId, 'export-doc-1');
});
