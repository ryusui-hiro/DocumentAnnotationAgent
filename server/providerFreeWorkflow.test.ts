import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ScriptedModel, assistantMessage, functionCall, modelResponder, modelResponse, type RecordedModelCall } from '@openai/agents/testing';
import type OpenAI from 'openai';
import { createAnnotationTaskPlan } from './taskPlanner';
import { configureDocumentExportStoreForTests, configurePendingAgentRunStoreForTests, getPendingAgentRunInfo, resumeDocumentAgentRun, runDocumentAgent } from './documentAgent';
import { createDocumentExportStore, documentExportStore } from './documentExportStore';
import { PagedDocumentAdapter } from './documentAdapter';
import { createPrivateRecordStore, privateRecordStore } from './privateRecordStore';
import { taskPlanAsInstructions } from '../src/taskPlan';
import type { DocumentAnnotationRecord } from '../src/types';
import type { PreviewReport } from 'document-svg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const taskPlanFixture = {
  title: 'Review ambiguous acoustic limits',
  objective: 'Find the acoustic maximum on the current page and ask for human review when its scope is unclear.',
  labels: [{ name: 'AMBIGUOUS LIMIT', description: 'A stated maximum whose operational scope needs human judgment.' }],
  actions: ['Highlight the exact region', 'Attach evidence and a brief explanation', 'Export reviewed findings as JSON'],
  uncertaintyPolicy: 'Do not infer how an unclear maximum applies; ask the user to decide.',
  workflow: ['Open and inspect the run-bound document page.', 'Request review for the ambiguous maximum.', 'After approval, export the structured JSON records.'],
};

let persistenceDirectory = '';
let isolatedStore: ReturnType<typeof createPrivateRecordStore>;
let isolatedExportStore: ReturnType<typeof createDocumentExportStore>;

before(async () => {
  persistenceDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-provider-free-workflow-'));
  isolatedStore = createPrivateRecordStore(persistenceDirectory);
  isolatedExportStore = createDocumentExportStore(isolatedStore);
  configurePendingAgentRunStoreForTests(isolatedStore);
  configureDocumentExportStoreForTests(isolatedExportStore);
});

after(async () => {
  configurePendingAgentRunStoreForTests(privateRecordStore);
  configureDocumentExportStoreForTests(documentExportStore);
  if (persistenceDirectory) await rm(persistenceDirectory, { recursive: true, force: true });
});

function readToolResult(call: RecordedModelCall, toolName: string): Record<string, unknown> {
  const item = Array.isArray(call.request.input)
    ? call.request.input.find((entry) => entry.type === 'function_call_result' && entry.name === toolName)
    : undefined;
  assert.ok(item, `the ${toolName} tool result is returned to the Agent`);
  const rawOutput = 'output' in item ? item.output : undefined;
  const outputText = typeof rawOutput === 'string' ? rawOutput
    : rawOutput && !Array.isArray(rawOutput) && typeof rawOutput === 'object' && 'text' in rawOutput ? String(rawOutput.text)
      : '';
  assert.ok(outputText, `${toolName} returns a JSON text result`);
  return JSON.parse(outputText) as Record<string, unknown>;
}

test('provider-free Agent opens its bound document, pauses for review, resumes the same run, and exports corrected JSON', async () => {
  let planRequest: Record<string, unknown> | undefined;
  const plannerClient = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        planRequest = request;
        return {
          output_text: JSON.stringify(taskPlanFixture),
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        };
      },
    },
  } as unknown as OpenAI;
  const planned = await createAnnotationTaskPlan({
    client: plannerClient,
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instruction: 'Review the acoustic maximum and ask me if its scope is ambiguous; export the approved result as JSON.',
    guidelines: 'Use only visible evidence.',
    correction: '',
    mode: 'assist',
  });
  assert.deepEqual(planned.plan, taskPlanFixture);
  assert.equal(planRequest?.store, false);
  const schema = planRequest?.text as { format?: { type?: string; strict?: boolean } } | undefined;
  assert.equal(schema?.format?.type, 'json_schema');
  assert.equal(schema?.format?.strict, true);

  const documentId = 'provider-free-bound-document';
  const sourceHash = 'provider-free-source-hash';
  const report = {
    sourceFormat: 'PDF',
    pageCount: 1,
    pages: [{
      number: 1,
      widthPoints: 120,
      heightPoints: 160,
      warningCount: 0,
      warnings: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><text x="8" y="30">ACOUSTIC PRESSURE</text><text x="8" y="52">55 dBA maximum</text></svg>',
    }],
  } as unknown as PreviewReport;
  class ObservedPagedDocumentAdapter extends PagedDocumentAdapter {
    openCalls = 0;

    override open() {
      this.openCalls += 1;
      return super.open();
    }
  }
  const adapter = new ObservedPagedDocumentAdapter('demo-specification.pdf', report, documentId);
  const evidence = 'ACOUSTIC PRESSURE\n55 dBA maximum';

  const model = new ScriptedModel([
    modelResponder((call) => {
      const initialContext = JSON.stringify(call.request.input);
      assert.match(initialContext, /Structured annotation task plan:/);
      assert.match(initialContext, /Review ambiguous acoustic limits/);
      const openTool = call.request.tools.find((candidate) => candidate.name === 'open_document');
      const infoTool = call.request.tools.find((candidate) => candidate.name === 'get_document_info');
      assert.ok(openTool, 'the run exposes open_document');
      assert.ok(infoTool, 'the run exposes get_document_info');
      assert.equal(openTool.type, 'function');
      if (openTool.type === 'function') {
        assert.equal(openTool.strict, true, 'open_document uses strict tool arguments');
        const parameters = openTool.parameters as Record<string, unknown>;
        assert.deepEqual(parameters.properties, {}, 'the model cannot provide a document selector');
        assert.equal(parameters.additionalProperties, false, 'the no-argument schema rejects extra selectors');
      }
      assert.equal(infoTool.type, 'function');
      if (infoTool.type === 'function') {
        assert.equal(infoTool.strict, true, 'get_document_info uses strict tool arguments');
        const parameters = infoTool.parameters as Record<string, unknown>;
        assert.deepEqual(parameters.properties, {}, 'the model cannot select another document for metadata');
        assert.equal(parameters.additionalProperties, false, 'the metadata tool rejects extra selectors');
      }
      return [functionCall('open_document', {}, { callId: 'open-bound-session' })];
    }),
    modelResponder((call) => {
      const opened = readToolResult(call, 'open_document');
      assert.deepEqual(opened, {
        opened: true,
        documentId,
        fileName: 'demo-specification.pdf',
        fileType: 'PDF',
        kind: 'paged',
        pageCount: 1,
        currentPage: 1,
      });
      return [functionCall('get_document_info', {}, { callId: 'bound-info' })];
    }),
    modelResponder((call) => {
      const info = readToolResult(call, 'get_document_info');
      assert.deepEqual(info, {
        found: true,
        documentId,
        fileName: 'demo-specification.pdf',
        fileType: 'PDF',
        kind: 'paged',
        pageCount: 1,
        currentPage: 1,
      });
      return [functionCall('get_document_outline', {}, { callId: 'bound-outline' })];
    }),
    modelResponder((call) => {
      const output = readToolResult(call, 'get_document_outline');
      assert.equal(output.totalPages, 1);
      assert.equal(output.currentPage, 1);
      assert.match(JSON.stringify(output.documentAdapters), /demo-specification\.pdf/);
      return [functionCall('inspect_page', {}, { callId: 'bound-inspect' })];
    }),
    modelResponder((call) => {
      const inspected = readToolResult(call, 'inspect_page');
      assert.equal(inspected.pageNumber, 1);
      assert.match(String(inspected.extractedText), /ACOUSTIC PRESSURE/);
      assert.match(String(inspected.extractedText), /55 dBA maximum/);
      return [functionCall('request_review', {
        x: 0.06,
        y: 0.12,
        width: 0.72,
        height: 0.22,
        label: 'AMBIGUOUS LIMIT',
        note: 'The page states a maximum without defining its operating scope.',
        reason: 'The document does not say whether this value applies continuously or only under a test condition.',
        excerpt: evidence,
        confidence: 0.6,
        reviewPriority: 'high',
        requiresReview: true,
      }, { callId: 'review-acoustic-maximum' })];
    }),
    modelResponder((call) => {
      const reviewed = readToolResult(call, 'request_review');
      assert.equal(reviewed.created, true);
      assert.equal(reviewed.id, 'review-acoustic-maximum');
      assert.equal(reviewed.reviewedByHuman, true, 'the same interrupted tool call executes only after approval');
      assert.equal(reviewed.requiresReview, false);
      return [functionCall('export_annotations', { format: 'annotations-json' }, { callId: 'export-reviewed-json' })];
    }),
    modelResponder((call) => {
      const exported = readToolResult(call, 'export_annotations');
      assert.equal(exported.prepared, true);
      assert.equal(exported.format, 'annotations-json');
      assert.equal(exported.annotationsExported, 1);
      return [assistantMessage('The human-reviewed JSON export is ready.')];
    }),
  ]);

  const paused = await runDocumentAgent({
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instruction: 'Review the acoustic maximum and ask me if its scope is ambiguous; export the approved result as JSON.',
    taskPlan: taskPlanAsInstructions(planned.plan),
    guidelines: 'Use only visible evidence.',
    correction: '',
    humanDecisions: '',
    pageText: adapter.getPositionedPageText(1).join('\n'),
    imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1,
    totalPages: 1,
    requestedScope: 'current',
    exportRequested: true,
    documentAdapters: [adapter],
    documentId,
    sourceHash,
    mode: 'assist',
  }, model);

  assert.equal(adapter.openCalls, 1, 'open_document opens the adapter bound to this run exactly once');
  assert.equal(paused.status, 'interrupted');
  assert.ok(paused.approvalRunId);
  assert.ok(paused.approvalId);
  assert.equal(paused.annotations.length, 1);
  assert.equal(paused.annotations[0]?.requiresReview, true);
  assert.equal(paused.annotations[0]?.reviewedByHuman, undefined);
  assert.deepEqual(paused.toolEvents.map((event) => event.toolName), [
    'open_document',
    'get_document_info',
    'get_document_outline',
    'inspect_page',
    'request_review',
  ]);
  const pending = await getPendingAgentRunInfo(paused.approvalRunId!);
  assert.equal(pending?.documentId, documentId, 'the review pause remains bound to the originally selected session');
  assert.equal(pending?.sourceHash, sourceHash);

  const resumed = await resumeDocumentAgentRun({
    runId: paused.approvalRunId!,
    approvalId: paused.approvalId!,
    approved: true,
  });
  model.assertComplete();
  assert.equal(resumed.status, 'complete');
  assert.deepEqual(resumed.annotations, [], 'the already reported review candidate is not duplicated on resume');
  const correctedRecord = adapter.listAnnotations()[0];
  assert.ok(correctedRecord);
  assert.equal(correctedRecord.id, paused.approvalId, 'approval resumes the same reviewed candidate');
  assert.equal(correctedRecord.reviewedByHuman, true);
  assert.equal(correctedRecord.requiresReview, false);
  assert.equal(correctedRecord.status, 'corrected');
  assert.equal(resumed.exports.length, 1);

  const prepared = resumed.exports[0]!;
  assert.equal(prepared.documentId, documentId);
  assert.equal(prepared.format, 'annotations-json');
  const artifact = await isolatedExportStore.get(prepared.id);
  assert.ok(artifact, 'the prepared export is retrievable from the isolated encrypted store');
  assert.equal(artifact.descriptor.documentId, documentId);
  assert.equal(artifact.descriptor.fileName, 'demo-specification-annotations.json');
  assert.equal(artifact.contentType, 'application/json');
  const payload = JSON.parse(artifact.buffer.toString('utf8')) as { documentAnnotations: DocumentAnnotationRecord[] };
  const corrected = payload.documentAnnotations.find((record) => record.id === paused.approvalId);
  assert.ok(corrected, 'the downloaded JSON contains the approved candidate');
  assert.equal(corrected.documentId, documentId);
  assert.equal(corrected.sourceHash, sourceHash);
  assert.equal(corrected.label, 'AMBIGUOUS LIMIT');
  assert.equal(corrected.status, 'corrected');
  assert.equal(corrected.evidence, evidence);
  assert.equal(corrected.reviewPriority, 'high');
  assert.equal(corrected.reviewedByHuman, true);
  assert.equal(corrected.requiresReview, false);
});

test('open_document fails closed when a run has no user-bound document session', async () => {
  const model = new ScriptedModel([
    modelResponse([functionCall('open_document', {}, { callId: 'open-unbound-document' })]),
    modelResponder((call) => {
      const opened = readToolResult(call, 'open_document');
      assert.deepEqual(opened, { opened: false, error: 'No user-opened document session is bound to this Agent run.' });
      return [functionCall('get_document_info', {}, { callId: 'info-unbound-document' })];
    }),
    modelResponder((call) => {
      const info = readToolResult(call, 'get_document_info');
      assert.deepEqual(info, { found: false, error: 'No matching user-opened document session is bound to this Agent run.' });
      return [assistantMessage('No document session was available, so I did not open a file.')];
    }),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra',
    reasoningEffort: 'low',
    instruction: 'Open the document and identify any limits.',
    guidelines: '',
    correction: '',
    humanDecisions: '',
    pageText: '',
    imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1,
    totalPages: 1,
    mode: 'observe',
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.toolEvents.map((event) => event.toolName), ['open_document', 'get_document_info']);
  assert.equal(result.toolEvents[0]?.status, 'complete');
  assert.match(result.toolEvents[0]?.detail ?? '', /No user-opened document session/);
  assert.match(result.toolEvents[1]?.detail ?? '', /No matching user-opened document session/);
});

test('open_document cannot switch to an adapter from a different document session', async () => {
  const report = {
    sourceFormat: 'PDF',
    pageCount: 1,
    pages: [{ number: 1, widthPoints: 120, heightPoints: 160, warningCount: 0, warnings: [], svg: '<svg><text>Private session</text></svg>' }],
  } as unknown as PreviewReport;
  class ObservedPagedDocumentAdapter extends PagedDocumentAdapter {
    openCalls = 0;

    override open() {
      this.openCalls += 1;
      return super.open();
    }
  }
  const foreignAdapter = new ObservedPagedDocumentAdapter('other.pdf', report, 'other-document-session');
  const model = new ScriptedModel([
    modelResponse([functionCall('open_document', {}, { callId: 'open-foreign-session' })]),
    modelResponder((call) => {
      const opened = readToolResult(call, 'open_document');
      assert.equal(opened.opened, false);
      assert.equal(opened.documentId, undefined);
      return [assistantMessage('The requested session is not the one bound to this run.')];
    }),
  ]);

  const result = await runDocumentAgent({
    model: 'gpt-6-astra',
    reasoningEffort: 'low',
    instruction: 'Open the current document.',
    guidelines: '',
    correction: '',
    humanDecisions: '',
    pageText: 'Current bound document text.',
    imageDataUrl: 'data:image/png;base64,AA==',
    pageNumber: 1,
    totalPages: 1,
    mode: 'observe',
    documentId: 'current-document-session',
    documentAdapters: [foreignAdapter],
  }, model);

  model.assertComplete();
  assert.equal(result.status, 'complete');
  assert.equal(foreignAdapter.openCalls, 0, 'the foreign session adapter is not opened');
  assert.equal(result.toolEvents[0]?.toolName, 'open_document');
  assert.match(result.toolEvents[0]?.detail ?? '', /No user-opened document session/);
});
