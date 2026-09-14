async (page) => {
  const fail = (message) => { throw new Error(`Browser E2E assertion failed: ${message}`); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const equal = (actual, expected, message) => {
    if (actual !== expected) fail(`${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const expandDisclosure = async (selector) => {
    const disclosure = page.locator(selector);
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
  };
  const workbookFixturePath = __WORKBOOK_FIXTURE_PATH__;
  const changedSourcePdfPath = __CHANGED_SOURCE_PDF_PATH__;
  const officeDocxFixturePath = __OFFICE_DOCX_FIXTURE_PATH__;
  const officePptxFixturePath = __OFFICE_PPTX_FIXTURE_PATH__;
  const navigationPdfFixturePath = __NAVIGATION_PDF_FIXTURE_PATH__;
  const folderFixtureDirectory = __FOLDER_FIXTURE_DIRECTORY__;
  const visualEvidenceDirectory = __VISUAL_EVIDENCE_DIRECTORY__;
  const productHuntAssetDirectory = __PRODUCT_HUNT_ASSET_DIRECTORY__;
  const demo = await page.evaluate(() => JSON.parse(document.body.textContent || 'null'));
  const acceptedContinuationRule = 'この安全措置を実施しないと運転できない場合は HIGH RISK とする。';
  const historyTask = 'Find torque limits and safety requirements on page 1. Ask me when the evidence is uncertain.';
  check(demo && demo.demo === true, 'the built-in demo document did not load');
  check(demo.fileName === 'demo-specification.pdf', 'the built-in fictional PDF was not selected');
  check(typeof demo.documentId === 'string' && /^[\da-f-]{36}$/i.test(demo.documentId), 'the demo document session ID is missing');
  check(typeof demo.sourceHash === 'string' && /^[\da-f]{64}$/i.test(demo.sourceHash), 'the demo source hash is missing');
  check(demo.pageCount >= 1, 'the demo PDF has no pages');

  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  equal(health.aiConfigured, false, 'the provider-free API unexpectedly reports configured credentials');
  equal(health.codexAppServerConfigured, false, 'the Codex App Server provider must be disabled');

  const consoleErrors = [];
  const expectedWorkspaceExpiryConsoleErrors = [];
  const requestUrls = [];
  const externalRequests = [];
  let mockedAgentRequestCount = 0;
  let agentNavigationViewportMode = false;
  const agentNavigationRequests = [];
  let releaseSecondAgentNavigationSegment;
  const secondAgentNavigationSegmentGate = new Promise((resolve) => { releaseSecondAgentNavigationSegment = resolve; });
  let folderBatchMode = false;
  let folderBatchRequestCount = 0;
  const folderBatchRequests = [];
  let expireNextWorkspaceExport = false;
  let captureWorkspaceRecovery = false;
  let workspaceRecoveryConversions = 0;
  let expiredWorkspaceDocumentId = '';
  let recoveredWorkspaceDocumentId = '';
  let officeAnnotationMode = null;
  const officeAnnotationRequests = [];
  const validatorRequests = [];
  const manualValidatorRequests = [];
  const convertedFileTypes = new Map();
  const correctionRuleRequests = [];
  let delayNextCorrectionRule = false;
  let releaseDelayedCorrectionRule;
  let markCorrectionRuleStarted;
  const delayedCorrectionRuleStarted = new Promise((resolve) => { markCorrectionRuleStarted = resolve; });
  const annotationRequests = [];
  const autopilotRequests = [];
  let coverageWarningMode = false;
  const coverageWarningRequests = [];
  const ruleContinuationRequests = [];
  const planRequests = [];
  let delayNextValidation = false;
  let releaseDelayedValidation;
  let markValidationStarted;
  const delayedValidationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  const currentUrl = page.url();
  const origin = currentUrl.slice(0, currentUrl.indexOf('/api/demo'));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (message.text() === 'Failed to load resource: the server responded with a status of 410 (Gone)') expectedWorkspaceExpiryConsoleErrors.push(message.text());
      else consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('request', (request) => requestUrls.push(request.url()));
  page.on('response', (response) => {
    if (!response.url().includes('/api/convert')) return;
    void response.json().then((payload) => {
      if (typeof payload.documentId === 'string' && typeof payload.fileType === 'string') {
        convertedFileTypes.set(payload.documentId, payload.fileType.toLowerCase());
      }
    }).catch(() => undefined);
  });
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    const isHttpRequest = requestUrl.startsWith('http://') || requestUrl.startsWith('https://');
    const isSameOrigin = requestUrl === origin || requestUrl.startsWith(`${origin}/`) || requestUrl.startsWith(`${origin}?`) || requestUrl.startsWith(`${origin}#`);
    if (isHttpRequest && !isSameOrigin) {
      externalRequests.push(requestUrl);
      await route.abort();
      return;
    }
    if (captureWorkspaceRecovery && requestUrl.endsWith('/api/convert')) workspaceRecoveryConversions += 1;
    const isDocumentExportRequest = /\/api\/documents\/[^/?#]+\/export(?:[?#]|$)/u.test(requestUrl);
    if (expireNextWorkspaceExport && route.request().method() === 'POST' && isDocumentExportRequest) {
      expireNextWorkspaceExport = false;
      const payload = route.request().postDataJSON();
      expiredWorkspaceDocumentId = String(payload.documentAnnotations?.[0]?.documentId ?? '');
      await route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'Expired fixture workspace session.' }) });
      return;
    }
    if (captureWorkspaceRecovery && route.request().method() === 'POST' && isDocumentExportRequest) {
      const payload = route.request().postDataJSON();
      recoveredWorkspaceDocumentId = String(payload.documentAnnotations?.[0]?.documentId ?? '');
    }
    if (requestUrl.includes('/api/ai/correction-rule')) {
      const payload = route.request().postDataJSON();
      correctionRuleRequests.push(payload);
      const responseBody = JSON.stringify({
        draft: {
          outcome: 'proposed_rule',
          rule: 'When a safety step must be completed before operation, classify it as HIGH RISK.',
          basis: 'The task asks for safety requirements, and the visible warning says to complete the step before servicing.',
        },
        provider: 'openai', model: 'gpt-6-astra',
        usage: { inputTokens: 17, outputTokens: 24, reasoningTokens: 8, cachedInputTokens: 0, totalTokens: 41 },
      });
      const fulfill = () => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: responseBody,
      });
      if (delayNextCorrectionRule) {
        delayNextCorrectionRule = false;
        markCorrectionRuleStarted();
        await new Promise((resolve) => { releaseDelayedCorrectionRule = () => { void fulfill().then(resolve); }; });
      } else await fulfill();
      return;
    }
    if (requestUrl.includes('/api/ai/plan')) {
      const payload = route.request().postDataJSON();
      planRequests.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          plan: { title: 'E2E safety review', objective: 'Find visible safety requirements.', labels: [{ name: 'HIGH RISK', description: 'A required safety procedure.' }], actions: ['Find safety procedures'], uncertaintyPolicy: 'Ask a person when evidence is unclear.', workflow: ['Inspect the page.', 'Classify the evidence.'] },
          source: 'model', provider: 'openai', model: 'gpt-6-astra', usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 2, cachedInputTokens: 0, totalTokens: 20 },
        }),
      });
      return;
    }
    if (requestUrl.includes('/api/ai/annotate')) {
      const payload = route.request().postDataJSON();
      mockedAgentRequestCount += 1;
      annotationRequests.push(payload);
      if (coverageWarningMode) {
        coverageWarningRequests.push(payload);
        const pageNumber = Number(payload.pageNumber ?? 1);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'complete', annotations: [], spreadsheetChanges: [],
            toolEvents: [{ toolName: 'inspect_page', phase: 'Reading', detail: 'Inspected page with a persistent converter warning.', status: 'complete', pageNumber, textBlockCount: 18, warningCount: 1 }],
            visitedPages: [pageNumber], inspectedPages: [pageNumber], remainingPages: [],
            pageCoverage: [{ pageNumber, status: 'checked', findingCount: 0, reviewCount: 0, warningCount: 1, textBlockCount: 18 }],
            usage: { requests: 1, inputTokens: 8, outputTokens: 4, reasoningTokens: 1, cachedInputTokens: 0, totalTokens: 12 },
            provider: 'openai', model: 'gpt-6-astra',
          }),
        });
        return;
      }
      if (payload.agentMode === 'autopilot') {
        autopilotRequests.push(payload);
        const totalPages = Math.max(1, Number(payload.totalPages ?? 1));
        const pageCoverage = Array.from({ length: totalPages }, (_, index) => ({
          pageNumber: index + 1, status: 'checked', findingCount: index === 0 ? 1 : 0, reviewCount: 0, warningCount: 0,
        }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'complete',
            annotations: [{
              id: 'e2e-autopilot-important', pageNumber: 1, x: 0.55, y: 0.58, width: 0.32, height: 0.09,
              label: 'AUTOPILOT IMPORTANT', note: 'The important finding is clearly supported.',
              reason: 'The visible evidence is unambiguous but important.', excerpt: 'Clear important fixture evidence.',
              confidence: 0.01, reviewPriority: 'high', requiresReview: false, source: 'ai',
            }],
            spreadsheetChanges: [],
            toolEvents: pageCoverage.map((item) => ({
              toolName: 'inspect_page', phase: 'Reading', detail: 'Inspected this page as part of the Autopilot full-document pass.',
              status: 'complete', pageNumber: item.pageNumber, textBlockCount: 18,
            })),
            visitedPages: pageCoverage.map((item) => item.pageNumber), pageCoverage,
            usage: { requests: 1, inputTokens: 9, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 0, totalTokens: 13 },
            provider: 'openai-compatible', model: 'gpt-6-astra',
          }),
        });
        return;
      }
      if (agentNavigationViewportMode) {
        agentNavigationRequests.push(payload);
        const segmentNumber = agentNavigationRequests.length;
        if (segmentNumber === 2) {
          await secondAgentNavigationSegmentGate;
        }
        const segmentInspectedPages = segmentNumber === 1
          ? [1, ...Array.from({ length: 10 }, (_, index) => index + 3)]
          : [2, 13, 14, 15];
        const segmentVisitedPages = segmentNumber === 1
          ? Array.from({ length: 12 }, (_, index) => index + 1)
          : [2, 13, 14, 15];
        const activity = segmentNumber === 1
          ? [
            { toolName: 'inspect_page', phase: 'Reading', detail: 'Read the opening page and its text layout.', status: 'complete', pageNumber: 1, textBlockCount: 18 },
            { toolName: 'navigate_page', phase: 'Navigating', detail: 'Opened page 2 to inspect the matching passage.', status: 'complete', pageNumber: 2 },
            { toolName: 'scroll_document', phase: 'Navigating', detail: 'Zoomed into the candidate passage.', status: 'complete', pageNumber: 2, viewport: { x: 0.14, y: 0.34, width: 0.48, height: 0.22 } },
            ...Array.from({ length: 10 }, (_, index) => {
              const pageNumber = index + 3;
              return [
                { toolName: 'navigate_page', phase: 'Navigating', detail: `Opened page ${pageNumber} in the first navigation segment.`, status: 'complete', pageNumber },
                { toolName: 'inspect_page', phase: 'Reading', detail: `Inspected page ${pageNumber} for task evidence.`, status: 'complete', pageNumber, textBlockCount: 16 },
              ];
            }).flat(),
          ]
          : [
            { toolName: 'navigate_page', phase: 'Navigating', detail: 'Reopened page 2 because it had not yet received a full inspection.', status: 'complete', pageNumber: 2 },
            { toolName: 'inspect_page', phase: 'Reading', detail: 'Inspected page 2 during the host coverage continuation.', status: 'complete', pageNumber: 2, textBlockCount: 22 },
            ...segmentInspectedPages.filter((pageNumber) => pageNumber !== 2).flatMap((pageNumber) => [
              { toolName: 'navigate_page', phase: 'Navigating', detail: `Opened page ${pageNumber} in the second navigation segment.`, status: 'complete', pageNumber },
              { toolName: 'inspect_page', phase: 'Reading', detail: `Inspected page ${pageNumber} for task evidence.`, status: 'complete', pageNumber, textBlockCount: 16 },
            ]),
            { toolName: 'navigate_page', phase: 'Navigating', detail: 'Returned to page 2 to finish with the evidence highlight.', status: 'complete', pageNumber: 2 },
            { toolName: 'scroll_document', phase: 'Navigating', detail: 'Focused the viewer on the highlighted passage.', status: 'complete', pageNumber: 2, viewport: { x: 0.14, y: 0.34, width: 0.48, height: 0.22 } },
          ];
        const result = {
          status: 'complete',
          annotations: segmentNumber === 1 ? [{
            id: 'e2e-agent-navigation-candidate', pageNumber: 2,
            x: 0.14, y: 0.34, width: 0.48, height: 0.09,
            label: 'NAVIGATION STREAM TARGET', note: 'The highlighted region was inspected after navigating.',
            reason: 'The streamed tool events should move the page viewer to this evidence.',
            excerpt: 'Fictional navigation fixture evidence.', confidence: 0.72,
            reviewPriority: 'low', requiresReview: false, source: 'ai',
          }] : [],
          // Keep navigation/scroll exclusively in the SSE activity frames so the
          // final-payload fallback cannot make the viewer assertions pass.
          spreadsheetChanges: [], toolEvents: activity.filter((event) => event.toolName === 'inspect_page'), visitedPages: segmentVisitedPages,
          inspectedPages: segmentInspectedPages,
          pageCoverage: segmentInspectedPages.map((pageNumber) => ({ pageNumber, status: 'checked', findingCount: pageNumber === 2 && segmentNumber === 1 ? 1 : 0, reviewCount: 0, warningCount: 0 })),
          usage: { requests: 1, inputTokens: 12, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 0, totalTokens: 20 },
          provider: 'openai', model: 'gpt-6-astra',
        };
        const frames = [
          ...activity.map((event) => `event: activity\ndata: ${JSON.stringify(event)}`),
          `event: result\ndata: ${JSON.stringify(result)}`,
          'event: done\ndata: {}',
        ];
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: `${frames.join('\n\n')}\n\n` });
        return;
      }
      if (folderBatchMode) {
        folderBatchRequestCount += 1;
        folderBatchRequests.push(payload);
        const isFirstDocument = folderBatchRequestCount === 1;
        const isWorkbook = convertedFileTypes.get(String(payload.documentId)) === 'xlsx';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'complete',
            annotations: isFirstDocument ? [{
              id: 'e2e-folder-review-candidate', pageNumber: Number(payload.pageNumber ?? 1),
              x: 0.12, y: 0.2, width: 0.42, height: 0.08,
              label: 'FOLDER BATCH REVIEW', note: 'Review this folder-batch finding.',
              reason: 'The first selected document has a review-only fixture finding.',
              excerpt: 'Safety inspection fixture evidence.', confidence: 0.61,
              reviewPriority: 'high', requiresReview: true, source: 'ai',
            }] : [],
            spreadsheetChanges: isWorkbook ? [{
              id: 'e2e-folder-xlsx-review', operation: 'write_cell', sheetName: 'Wide', range: 'B2', values: [['HIGH']],
              reason: 'The evidence is incomplete and needs a person to confirm the classification.',
              reviewPriority: 'high', requiresReview: true,
            }] : [],
            toolEvents: [], visitedPages: [Number(payload.pageNumber ?? 1)],
            pageCoverage: [{ pageNumber: Number(payload.pageNumber ?? 1), status: 'checked', findingCount: isFirstDocument ? 1 : 0, reviewCount: isFirstDocument ? 1 : 0, warningCount: 0 }],
            usage: { requests: 1, inputTokens: 8, outputTokens: 4, reasoningTokens: 1, cachedInputTokens: 0, totalTokens: 12 },
            provider: 'openai', model: 'gpt-6-astra',
          }),
        });
        return;
      }
      if (officeAnnotationMode) {
        const mode = officeAnnotationMode;
        officeAnnotationRequests.push({ mode, payload });
        const excerpt = mode === 'docx' ? 'Either party may terminate without cause.' : 'Confidential product roadmap';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'complete',
            annotations: [{
              id: `e2e-${mode}-confirmed`, pageNumber: Number(payload.pageNumber ?? 1),
              x: 0.1, y: 0.2, width: 0.7, height: 0.12,
              label: mode === 'docx' ? 'HIGH RISK' : 'PRODUCT',
              note: 'An Office fixture finding was confirmed.',
              reason: 'The visible Office source supports this classification.',
              excerpt, confidence: 0.92, reviewPriority: 'medium', requiresReview: false, source: 'ai',
            }],
            spreadsheetChanges: [], toolEvents: [], visitedPages: [Number(payload.pageNumber ?? 1)],
            pageCoverage: [{ pageNumber: Number(payload.pageNumber ?? 1), status: 'checked', findingCount: 1, reviewCount: 0, warningCount: 0 }],
            usage: { requests: 1, inputTokens: 8, outputTokens: 4, reasoningTokens: 1, cachedInputTokens: 0, totalTokens: 12 },
            provider: 'openai', model: 'gpt-6-astra',
          }),
        });
        return;
      }
      if (typeof payload.humanDecisions === 'string' && payload.humanDecisions.includes(acceptedContinuationRule)) {
        ruleContinuationRequests.push(payload);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'complete', annotations: [], spreadsheetChanges: [], toolEvents: [],
          visitedPages: [Number(payload.pageNumber ?? 1)],
          pageCoverage: [{ pageNumber: Number(payload.pageNumber ?? 1), status: 'checked', findingCount: 0, warningCount: 0 }],
          usage: { requests: 1, inputTokens: 12, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 0, totalTokens: 20 },
          provider: 'openai', model: 'gpt-6-astra',
        }),
      });
      return;
    }
    if (requestUrl.includes('/api/ai/validate')) {
      const payload = route.request().postDataJSON();
      validatorRequests.push(payload);
      const isRuleContinuation = typeof payload.humanDecisions === 'string' && payload.humanDecisions.includes(acceptedContinuationRule);
      if (isRuleContinuation) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ findings: [], usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 10, requests: 1 }, provider: 'openai', model: 'gpt-6-astra' }) });
        return;
      }
      const validationNumber = manualValidatorRequests.length + 1;
      manualValidatorRequests.push(payload);
      const firstAnnotation = Array.isArray(payload.annotations) ? payload.annotations[0] : undefined;
      const responseBody = JSON.stringify({
        findings: firstAnnotation && validationNumber !== 2 ? [{
          id: 'e2e-validator-evidence-gap',
          kind: 'evidence_gap',
          annotationIds: [firstAnnotation.id],
          title: '根拠をもう一度確認してください',
          reason: 'このテスト用レビューは現在の注釈だけを参照しています。',
          reviewPriority: 'high',
        }] : [],
        usage: { inputTokens: 21, outputTokens: 8, reasoningTokens: 5, cachedInputTokens: 0, totalTokens: 29, requests: 1 },
        provider: 'openai',
        model: 'gpt-6-astra',
      });
      const fulfill = () => route.fulfill({ status: 200, contentType: 'application/json', body: responseBody });
      if (delayNextValidation) {
        delayNextValidation = false;
        markValidationStarted();
        await new Promise((resolve) => {
          releaseDelayedValidation = () => { void fulfill().then(resolve); };
        });
      } else {
        await fulfill();
      }
      return;
    }
    await route.continue();
  });

  await page.addInitScript((fixture) => {
    if (sessionStorage.getItem('__visualDocumentE2eSeeded') !== 'true') {
      localStorage.clear();
      localStorage.setItem('annotation-studio:language:v1', 'ja');
      localStorage.setItem('annotation-studio:settings:v1', JSON.stringify({ provider: 'openai-api', model: 'gpt-6-astra', reasoningEffort: 'medium', endpoint: 'https://api.openai.com/v1', apiServerUrl: '' }));
      const baseKey = `annotation-studio:annotations:${fixture.fileName}`;
      const versionKey = `${baseKey}:source:${fixture.sourceHash}`;
      const state = {
        version: 4,
        sourceHash: fixture.sourceHash,
        documentId: fixture.documentId,
        fileType: fixture.fileType,
        documentAnnotations: [],
        annotationOperations: [],
        consistencyIssues: [],
        preparedExports: [],
        continuation: null,
        task: {},
      };
      localStorage.setItem(versionKey, JSON.stringify(state));
      localStorage.setItem(baseKey, JSON.stringify({ version: 4, sourceHash: fixture.sourceHash, workspaceKey: versionKey }));
      sessionStorage.setItem('__visualDocumentE2eSeeded', 'true');
    }

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
      if (this.download?.endsWith('-annotations.json')) {
        window.__visualDocumentE2eExportFilename = this.download;
        window.__visualDocumentE2eExportPromise = fetch(this.href).then(async (response) => {
          if (!response.ok) throw new Error(`Export blob returned HTTP ${response.status}.`);
          const serialized = await response.text();
          window.__visualDocumentE2eExportText = serialized;
          return serialized;
        });
      } else if (this.download?.endsWith('-history.json')) {
        window.__visualDocumentE2eHistoryFilename = this.download;
        window.__visualDocumentE2eHistoryPromise = fetch(this.href).then(async (response) => {
          if (!response.ok) throw new Error(`History export returned HTTP ${response.status}.`);
          const serialized = await response.text();
          window.__visualDocumentE2eHistoryText = serialized;
          return serialized;
        });
      } else if (/-annotated\.(?:docx|pptx)$/i.test(this.download ?? '')) {
        window.__visualDocumentE2eOfficeExportFilename = this.download;
        window.__visualDocumentE2eOfficeExportPromise = fetch(this.href).then(async (response) => {
          if (!response.ok) throw new Error(`Office export returned HTTP ${response.status}.`);
          const bytes = await response.arrayBuffer();
          window.__visualDocumentE2eOfficeExportByteLength = bytes.byteLength;
          window.__visualDocumentE2eOfficeExportHeaders = {
            wordCommentsAdded: response.headers.get('X-Word-Comments-Added'),
            pptxAnnotationsAdded: response.headers.get('X-PPTX-Annotations-Added'),
            pptxSlidesTagged: response.headers.get('X-PPTX-Slides-Tagged'),
          };
          return bytes.byteLength;
        });
      }
      return originalClick.apply(this, args);
    };
  }, demo);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=advanced`);

  const scenarios = [
    { action: 'approve', candidate: '制限値', expectedLabel: '制限値', expectedSource: 'ai', expectedStatus: 'approved' },
    { action: 'correct', candidate: '安全上の注意', otherCandidate: '制限値', expectedLabel: '人が修正した安全基準', expectedSource: 'manual', expectedStatus: 'corrected' },
    { action: 'reject', candidate: '制限値', expectedLabel: '制限値' },
  ];
  const outcomes = [];

  const waitForReadyDocument = async () => {
    await page.getByRole('heading', { name: '見つけたいことを、ひとこと。', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#ai-prompt').waitFor({ state: 'visible' });
    await page.locator('.document-page-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const image = document.querySelector('.document-page-image');
      const runButton = document.querySelector('.page-run-button');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && runButton && !runButton.disabled;
    });
  };
  const waitForWorkspaceDocumentOpen = async (fileName, workbook = false) => {
    const deadline = Date.now() + 20_000;
    let lastState;
    while (Date.now() < deadline) {
      lastState = await page.evaluate(() => {
        const image = document.querySelector('.document-page-image');
        return {
          heading: document.querySelector('.document-heading h1')?.textContent?.trim(),
          workbookPreview: Boolean(document.querySelector('.workbook-preview')),
          pagePreview: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          uploadDisabled: document.querySelector('.upload-link')?.hasAttribute('disabled'),
          activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
          message: document.querySelector('.message-banner')?.textContent?.trim(),
        };
      });
      if (lastState.heading === fileName && (workbook ? lastState.workbookPreview : lastState.pagePreview) && !lastState.uploadDisabled) return;
      await page.waitForTimeout(100);
    }
    fail(`the ${fileName} workspace document did not finish opening: ${JSON.stringify(lastState)}`);
  };
  const waitForRestoredDocument = async () => {
    await page.getByRole('heading', { name: '見つけたいことを、ひとこと。', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#ai-prompt').waitFor({ state: 'visible' });
    await page.locator('.document-page-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const image = document.querySelector('.document-page-image');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    });
  };
  const waitForWorkspaceDocumentEnabled = async (relativePath) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate((path) => {
        const item = [...document.querySelectorAll('.workspace-document-item')].find((entry) => entry.textContent?.includes(path));
        const button = item?.querySelector('.workspace-document-open');
        return { exists: Boolean(button), disabled: button?.hasAttribute('disabled') };
      }, relativePath);
      if (state.exists && !state.disabled) return;
      await page.waitForTimeout(100);
    }
    const state = await page.evaluate((path) => {
      const item = [...document.querySelectorAll('.workspace-document-item')].find((entry) => entry.textContent?.includes(path));
      const button = item?.querySelector('.workspace-document-open');
      return { disabled: button?.hasAttribute('disabled'), html: button?.outerHTML, progress: document.querySelector('.workspace-progress')?.textContent, status: document.body.innerText.slice(-600) };
    }, relativePath);
    fail(`the ${relativePath} project document remained unavailable after batch processing: ${JSON.stringify(state)}`);
  };

  const waitUntil = async (predicate, message, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await page.waitForTimeout(50);
    }
    const activity = await page.locator('section[aria-label="Agent Activity"]').innerText().catch(() => '(activity unavailable)');
    fail(`${message}; rule continuation requests=${ruleContinuationRequests.length}; annotation requests=${annotationRequests.length}; human decision payloads=${JSON.stringify(annotationRequests.map((request) => request.humanDecisions ?? ''))}; activity=${activity.slice(-900)}`);
  };

  const contractDemoAction = page.getByTestId('open-contract-demo');
  await contractDemoAction.waitFor({ state: 'visible' });
  await contractDemoAction.click();
  await page.getByRole('heading', { name: 'fictional-termination-contract.pdf', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('termination-demo-notice').waitFor({ state: 'visible' });
  check((await page.getByTestId('termination-demo-notice').innerText()).includes('AI未実行'), 'the fictional review sample did not disclose that no model ran');
  check((await page.getByTestId('termination-demo-notice').innerText()).includes('Find every termination clause'), 'the sample prompt was not visible beside the scripted review output');
  equal(await page.locator('#ai-prompt').inputValue(), 'Find every termination clause, classify it as High / Medium / Low risk, highlight the evidence, and ask me when the wording is uncertain.', 'the contract sample did not load its scripted prompt');
  equal(await page.locator('.annotation-box').count(), 3, 'page 2 should show two preset highlights and the ambiguous review box');
  const fixedHighlightEvidence = await page.locator('.annotation-box').evaluateAll((items) => items.map((item) => ({ label: item.getAttribute('aria-label'), text: item.textContent })));
  check(fixedHighlightEvidence.some((item) => item.label?.includes('HIGH RISK') && item.label.includes('8.5')), `the page-2 high-risk termination clause did not receive its visible preset highlight: ${JSON.stringify(fixedHighlightEvidence)}`);
  equal(await page.locator('.candidate-card').count(), 1, 'the contract sample should queue exactly one intentionally ambiguous clause');
  const ambiguousCandidate = page.locator('.candidate-card').filter({ hasText: 'MEDIUM RISK? · 8.6' });
  check(await ambiguousCandidate.isVisible(), 'the ambiguous termination clause is not in the human review queue');
  check((await ambiguousCandidate.innerText()).includes('reasonable business circumstances'), 'the review candidate omitted the ambiguous evidence');
  check((await ambiguousCandidate.innerText()).includes('no advance notice period'), 'the review candidate omitted the missing-notice reason');
  await page.screenshot({ path: `${visualEvidenceDirectory}/termination-contract-review-1440x1000.png`, fullPage: false });

  await page.getByRole('button', { name: '前のページ' }).click();
  await page.waitForFunction(() => document.querySelector('.page-controls strong')?.textContent === '1');
  const firstPageHighlightEvidence = await page.locator('.annotation-box').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check(firstPageHighlightEvidence.some((label) => label?.includes('HIGH RISK') && label.includes('8.2')), `the one-sided page-1 termination clause did not receive its visible preset highlight: ${JSON.stringify(firstPageHighlightEvidence)}`);

  const contractPreview = await page.evaluate(async () => {
    const response = await fetch('/api/demo/termination-contract');
    if (!response.ok) throw new Error(`Contract demo returned HTTP ${response.status}.`);
    const document = await response.json();
    const previews = await Promise.all(document.pages.map(async (item) => {
      const pageResponse = await fetch(`/api/documents/${document.documentId}/pages/${item.pageNumber}.svg`);
      if (!pageResponse.ok) throw new Error(`Contract demo page ${item.pageNumber} returned HTTP ${pageResponse.status}.`);
      return await pageResponse.text();
    }));
    return { document, previews };
  });
  equal(contractPreview.document.fileName, 'fictional-termination-contract.pdf', 'the contract demo endpoint returned a different sample');
  equal(contractPreview.document.demo, true, 'the contract sample was not marked as a demo');
  equal(contractPreview.document.pageCount, 2, 'the contract sample must include both clause pages');
  check(/^[\da-f]{64}$/i.test(contractPreview.document.sourceHash), 'the contract demo source hash is missing');
  const contractText = contractPreview.previews.join('\n');
  for (const clause of ['Termination for Convenience', 'Customer Termination at Will', 'Termination for Material Breach', 'Insolvency Event', 'Repeated Service Failure', 'Reasonable Business Circumstances']) {
    check(contractText.includes(clause), `the deterministic contract PDF omitted clause ${clause}`);
  }
  check(contractText.includes('not legal advice'), 'the fictional PDF omitted its disclaimer');
  check(!contractText.includes('PRESET LABEL') && !contractText.includes('HUMAN REVIEW: AMBIGUOUS') && !contractText.includes('AMBIGUITY NOTE'), 'scripted classifications leaked into the source contract instead of staying in the app review layer');

  await ambiguousCandidate.getByRole('button', { name: 'P.2' }).click();
  check((await page.locator('.page-controls').innerText()).includes('2 / 2'), 'the ambiguous candidate did not navigate the PDF viewer to page 2');
  await page.locator('.export-menu-toggle').click();
  const archiveDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '確定範囲をまとめて抽出（ZIP）' }).click();
  const archive = await archiveDownload;
  await archive.saveAs(`${visualEvidenceDirectory}/contract-extractions.zip`);
  check(archive.suggestedFilename().endsWith('-extractions.zip'), 'the extraction archive is missing its ZIP filename');
  await page.getByRole('status').filter({ hasText: 'PNG画像・抜粋ノート・ラベルとページ座標をZIPにまとめました' }).waitFor({ state: 'visible' });
  await ambiguousCandidate.getByRole('button', { name: '確認して追加' }).click();
  await page.getByRole('tab', { name: /注釈/ }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('注釈'));
  equal(await page.locator('#annotation-label').inputValue(), 'MEDIUM RISK? · 8.6', 'approving the scripted ambiguous case did not add it to page annotations');
  equal(await page.locator('.candidate-section').count(), 0, 'the human-approved ambiguous case remained in the pending queue');
  check((await page.getByTestId('termination-demo-notice').innerText()).includes('AI未実行'), 'the no-model disclosure disappeared after human review');
  check(!requestUrls.some((url) => /\/api\/ai\/(?:annotate|plan|correction-rule|validate)/u.test(url)), 'loading or reviewing the scripted contract sample unexpectedly called an AI endpoint');
  equal(externalRequests.length, 0, 'the contract sample made an external network request');
  console.log('Contract review demo passed: optional fictional PDF, six termination clauses, one scripted ambiguous review candidate, human approval, and persistent no-model disclosure.');

  await page.getByTestId('open-llm-demo-menu').click();
  await page.getByTestId('open-live-contract-demo').click();
  await page.getByRole('heading', { name: 'fictional-termination-contract-live.pdf', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('termination-demo-notice').waitFor({ state: 'visible' });
  check((await page.getByTestId('termination-demo-notice').innerText()).includes('まだモデル未実行'), 'the live contract demo should disclose that the model has not run');
  check((await page.getByTestId('termination-demo-notice').innerText()).includes('not legal advice') || (await page.getByTestId('termination-demo-notice').innerText()).includes('法的判断には使わない'), 'the live contract demo should keep its fictional/legal disclaimer visible');
  equal(await page.locator('#ai-prompt').inputValue(), 'Review every termination clause in this fictional agreement. Classify each as HIGH, MEDIUM, or LOW risk, highlight the exact evidence, explain the reason, and ask me to review unclear wording.', 'the live contract demo did not load its practical annotation task');
  equal(await page.locator('.agent-mode-grid').getByRole('button', { name: /Autopilot/ }).getAttribute('aria-pressed'), 'true', 'the live contract demo should use the mode that applies clear clauses and asks only about uncertainty');
  const liveContractSource = await page.evaluate(async () => fetch('/api/demo/termination-contract-live').then((response) => response.json()));
  equal(liveContractSource.pageCount, 11, 'the Product Hunt contract source should have eleven pages for visible long-document navigation');
  equal(liveContractSource.pages.length, 11, 'the live contract route did not return every page in its outline');
  equal(await page.locator('.annotation-box').count(), 0, 'the live contract demo must not reuse preset annotations from the separate scripted sample');
  equal(await page.locator('.candidate-card').count(), 0, 'the live contract demo must not reuse preset review candidates from the separate scripted sample');
  await page.locator('.ai-run-button').click();
  await page.getByRole('dialog', { name: '接続と使用量' }).waitFor({ state: 'visible' });
  check(!requestUrls.some((url) => /\/api\/ai\/(?:annotate|plan|correction-rule|validate)/u.test(url)), 'the live contract demo must require a model before generating any results');
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  console.log('Live contract LLM demo passed: separate empty workspace, loaded review rubric, model-connection gate, and no scripted results.');

  await page.getByTestId('open-llm-demo-menu').click();
  await page.getByTestId('open-live-feedback-demo').click();
  await page.getByRole('heading', { name: 'customer-feedback-demo.xlsx', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('feedback-demo-notice').waitFor({ state: 'visible' });
  await page.locator('.workbook-preview').waitFor({ state: 'visible', timeout: 15_000 });
  check(await page.locator('#ai-prompt').isVisible(), 'the LLM demo task should be visible beside the workbook before the model run');
  check((await page.getByTestId('feedback-demo-notice').innerText()).includes('ラベル未記入'), 'the live feedback demo should disclose that output labels are blank');
  check((await page.getByTestId('feedback-demo-notice').innerText()).includes('AI未実行'), 'the live feedback demo should disclose that the model has not run');
  equal(await page.locator('#ai-prompt').inputValue(), 'Classify every customer feedback row. Add columns for Intent, Sentiment, Urgency, Evidence quote, Human review, and Review reason. Fill one result per Ticket ID, preserve the source columns, and send uncertain cases to human review.', 'the feedback demo did not load its practical annotation task');
  equal(await page.locator('.annotation-box').count(), 0, 'the live feedback demo should not preload scripted visual annotations');
  const feedbackPreview = await page.evaluate(() => {
    const root = document.querySelector('#root')?.getBoundingClientRect();
    const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
    const preview = document.querySelector('.workbook-preview')?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.workbook-preview tbody tr')].map((row) => row.textContent ?? '');
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootWidth: root?.width ?? 0,
      shellWidth: shell?.width ?? 0,
      preview: preview ? { left: preview.left, right: preview.right, top: preview.top, bottom: preview.bottom, width: preview.width, height: preview.height } : null,
      previewVisible: Boolean(preview && preview.width > 0 && preview.left >= 0 && preview.right <= window.innerWidth),
      rows,
    };
  });
  equal(feedbackPreview.rootWidth, 1440, 'feedback demo should span the full desktop viewport');
  equal(feedbackPreview.shellWidth, 1440, 'feedback demo shell should span the full desktop viewport');
  check(feedbackPreview.scrollWidth <= feedbackPreview.clientWidth, 'feedback demo has horizontal page overflow');
  check(feedbackPreview.previewVisible, `the workbook preview is not visible in the full application viewport: ${JSON.stringify(feedbackPreview.preview)}`);
  check(feedbackPreview.rows.some((row) => row.includes('FB-001')) && feedbackPreview.rows.some((row) => row.includes('FB-016')), `the public workbook preview did not show all 16 source tickets: ${feedbackPreview.rows.length}`);
  if (await page.locator('.toast').count()) await page.locator('.toast button').click();
  await page.screenshot({ path: `${productHuntAssetDirectory}/customer-feedback-demo-ready-1440x1000.png`, fullPage: false, animations: 'disabled' });
  await page.getByRole('button', { name: 'Excelを分類' }).click();
  await page.getByRole('dialog', { name: '接続と使用量' }).waitFor({ state: 'visible' });
  check(!requestUrls.some((url) => /\/api\/ai\/(?:annotate|plan|correction-rule|validate)/u.test(url)), 'the live feedback demo must require a model before generating any results');
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  console.log('Customer feedback LLM demo passed: 16 blank synthetic records, live-model-only run guard, full-width worksheet preview, and no scripted annotations.');

  await page.getByTestId('open-llm-demo-menu').click();
  await page.getByTestId('open-live-churn-demo').click();
  await page.getByRole('heading', { name: 'customer-churn-risk-demo.xlsx', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('churn-demo-notice').waitFor({ state: 'visible' });
  await page.locator('.workbook-preview').waitFor({ state: 'visible', timeout: 15_000 });
  check((await page.getByTestId('churn-demo-notice').innerText()).includes('ラベル未記入'), 'the churn demo should disclose that output labels are blank');
  check((await page.getByTestId('churn-demo-notice').innerText()).includes('AI未実行'), 'the churn demo should disclose that the model has not run');
  equal(await page.locator('#ai-prompt').inputValue(), 'Classify every synthetic customer as High, Medium, or Low churn risk. Fill one label in the existing blank Churn Risk column for each customer, preserve every source field, and ask me to review missing or conflicting evidence.', 'the churn demo did not load its classification task');
  equal(await page.locator('#task-preset').inputValue(), 'churn-risk', 'the churn demo did not select its dedicated task preset');
  equal(await page.locator('.agent-mode-grid').getByRole('button', { name: /Autopilot/ }).getAttribute('aria-pressed'), 'true', 'the churn demo should use Autopilot to fill every clear classification');
  equal(await page.locator('.annotation-box').count(), 0, 'the churn demo should not preload scripted annotations');
  const churnWorkbook = await page.evaluate(async () => {
    const heading = document.querySelector('.document-heading h1')?.textContent?.trim();
    const response = await fetch('/api/demo/customer-churn-risk');
    if (!response.ok) throw new Error(`Churn demo returned HTTP ${response.status}.`);
    const documentData = await response.json();
    const workbookResponse = await fetch(`/api/documents/${documentData.documentId}/workbook`);
    if (!workbookResponse.ok) throw new Error(`Churn workbook summary returned HTTP ${workbookResponse.status}.`);
    const summary = await workbookResponse.json();
    const sheet = summary.sheets[0];
    const gridHeaders = [...window.document.querySelectorAll('.workbook-grid thead tr th strong')].map((item) => item.textContent?.trim() ?? '');
    const visibleRiskValues = [...window.document.querySelectorAll('.workbook-grid tbody tr')].map((row) => row.cells[6]?.innerText?.trim() ?? '');
    const visibleLoginValues = [...window.document.querySelectorAll('.workbook-grid tbody tr')].map((row) => row.cells[3]?.innerText?.trim() ?? '');
    return { heading, document: documentData, sheet, changes: summary.changes, gridHeaders, visibleRiskValues, visibleLoginValues };
  });
  equal(churnWorkbook.heading, 'customer-churn-risk-demo.xlsx', 'the churn route did not open the dedicated workbook');
  equal(churnWorkbook.document.demo, true, 'the churn workbook was not marked as synthetic demo data');
  equal(churnWorkbook.document.fileName, 'customer-churn-risk-demo.xlsx', 'the churn route returned a different sample');
  equal(churnWorkbook.sheet.name, 'Customers', 'the churn workbook should have a Customers worksheet');
  equal(churnWorkbook.sheet.rowCount, 19, 'the churn workbook should contain 18 synthetic customers and one header row');
  equal(churnWorkbook.sheet.columnCount, 6, 'the churn workbook should contain five source fields and one output field');
  equal(churnWorkbook.sheet.headers.join('|'), 'name|plan|last_login|tickets|monthly_usage|Churn Risk', 'the churn workbook columns do not match the classification task');
  equal(churnWorkbook.gridHeaders.join('|'), 'name|plan|last_login|tickets|monthly_usage|Churn Risk', 'the visible churn worksheet does not show the requested input and output fields');
  equal(churnWorkbook.sheet.sampleRows.length, 18, 'the workbook summary did not expose all 18 customer records');
  check(churnWorkbook.sheet.sampleRows.every((row) => row.values[5] === null || row.values[5] === ''), 'the public churn workbook or API route contains a prefilled risk label');
  equal(churnWorkbook.changes.length, 0, 'the churn route should not preload saved annotation changes');
  check(churnWorkbook.visibleRiskValues.length === 18 && churnWorkbook.visibleRiskValues.every((value) => value === '—'), 'the visible Churn Risk cells must all remain blank before a run');
  equal(churnWorkbook.visibleLoginValues[0], '2026-07-01', 'the typed last_login date should display as an ISO date');
  equal(churnWorkbook.visibleLoginValues.at(-1), '2026-08-31', 'the final typed last_login date should display as an ISO date');
  if (await page.locator('.toast').count()) await page.locator('.toast button').click();
  await page.screenshot({ path: `${productHuntAssetDirectory}/customer-churn-risk-demo-ready-1440x1000.png`, fullPage: false, animations: 'disabled' });
  await page.getByRole('button', { name: 'Autopilotを開始' }).click();
  await page.getByRole('dialog', { name: '接続と使用量' }).waitFor({ state: 'visible' });
  check(!requestUrls.some((url) => /\/api\/ai\/(?:annotate|plan|correction-rule|validate)/u.test(url)), 'the churn demo must require a model before generating classifications');
  equal(externalRequests.length, 0, 'the churn demo made a real external provider request');
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  console.log('Customer churn-risk demo passed: dedicated task and route, 18 balanced blank synthetic records, live-model-only run guard, and no external requests.');

  await page.goto(`${origin}/?view=advanced`);
  await waitForReadyDocument();
  const modePicker = page.getByTestId('agent-mode-picker');
  const modeGroup = page.getByRole('group', { name: 'Agent mode' });
  check(await modePicker.isVisible(), 'Agent mode choices should be visible in the main workbench');
  equal(await page.locator('.agent-settings-details').evaluate((element) => element.open), false, 'mode choices should not depend on expanding task and model settings');
  equal(await modeGroup.locator('button').count(), 4, 'the main workbench should show all four Agent modes');
  for (const label of ['Observe', 'Suggest', 'Assist', 'Autopilot']) {
    check(await modeGroup.getByRole('button', { name: new RegExp(label) }).isVisible(), `${label} mode should be visible without opening settings`);
  }
  for (const [width, height, name] of [[1440, 900, 'agent-modes-1440x900'], [1280, 720, 'agent-modes-1280x720'], [390, 844, 'agent-modes-390x844']]) {
    await page.setViewportSize({ width, height });
    // Mobile gives document and instructions priority; all mode controls remain reachable by panel scrolling.
    if (width <= 850) await modeGroup.scrollIntoViewIfNeeded();
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('#root')?.getBoundingClientRect();
      const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
      const picker = document.querySelector('[data-testid="agent-mode-picker"]')?.getBoundingClientRect();
      const panelFooter = document.querySelector('.panel-footer')?.getBoundingClientRect();
      const choices = [...document.querySelectorAll('[data-testid="agent-mode-picker"] .agent-mode-option')].map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        rootWidth: root?.width ?? 0,
        shellWidth: shell?.width ?? 0,
        picker: picker ? { left: picker.left, right: picker.right, top: picker.top, bottom: picker.bottom, width: picker.width, height: picker.height } : null,
        panelFooterTop: panelFooter?.top ?? window.innerHeight,
        choices,
        settingsOpen: Boolean(document.querySelector('.agent-settings-details')?.open),
      };
    });
    equal(metrics.rootWidth, width, `${name} application root should span the viewport`);
    equal(metrics.shellWidth, width, `${name} workspace shell should span the viewport`);
    check(metrics.scrollWidth <= metrics.clientWidth, `${name} layout has horizontal overflow`);
    check(metrics.picker && metrics.picker.width > 0 && metrics.picker.left >= 0 && metrics.picker.right <= width && metrics.picker.top >= 0 && metrics.picker.bottom <= Math.min(height, metrics.panelFooterTop), `${name} mode selector should be fully visible above the panel footer: ${JSON.stringify({ picker: metrics.picker, panelFooterTop: metrics.panelFooterTop })}`);
    equal(metrics.choices.length, 4, `${name} mode selector should retain all four choices`);
    check(metrics.choices.every((choice) => choice.width > 0 && choice.height > 0 && choice.left >= 0 && choice.right <= width && choice.top >= 0 && choice.bottom <= Math.min(height, metrics.panelFooterTop)), `${name} mode option is clipped or hidden by the panel footer: ${JSON.stringify(metrics.choices)}`);
    equal(metrics.settingsOpen, false, `${name} mode selector should remain visible with advanced settings closed`);
    await page.screenshot({ path: `${visualEvidenceDirectory}/${name}.png`, fullPage: false, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const suggestMode = modeGroup.getByRole('button', { name: /Suggest/ });
  await suggestMode.click();
  equal(await suggestMode.getAttribute('aria-pressed'), 'true', 'the visible mode selector should switch to Suggest without opening settings');
  equal(await page.locator('.agent-settings-details').evaluate((element) => element.open), false, 'changing mode should leave advanced settings closed');
  await modeGroup.getByRole('button', { name: /Assist/ }).click();
  equal(await modeGroup.getByRole('button', { name: /Assist/ }).getAttribute('aria-pressed'), 'true', 'the visible mode selector should restore Assist directly');
  equal(await page.locator('.document-heading h1').innerText(), demo.fileName, 'returning from the optional contract demo did not preserve the cooling-fan demo as the default');

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    if (index > 0) {
      await page.evaluate(() => sessionStorage.removeItem('__visualDocumentE2eSeeded'));
      await page.reload();
    }
    await waitForReadyDocument();
    equal(await page.locator('.candidate-section .candidate-card').count(), 0, 'the clean E2E workspace should start without annotations or candidates');
    equal(await page.locator('.agent-mode-grid button').filter({ hasText: 'Assist' }).getAttribute('aria-pressed'), 'true', 'Assist mode should be selected for human review');

    await page.locator('#ai-prompt').fill(historyTask);
    await page.locator('.guideline-details summary').click();
    await page.locator('#annotation-guidelines').fill('Use a concise label, quote the visible passage, and explain why it needs review.');
    await expandDisclosure('.task-planning-details');
    await page.getByRole('button', { name: /作業仕様を確認/ }).click();
    const planCard = page.getByRole('region', { name: 'Annotation Task Plan' });
    await planCard.waitFor({ state: 'visible' });
    const planText = await planCard.innerText();
    check(planText.includes('ローカル下書き'), 'the plan was not visibly produced by the provider-free local planner');
    check(planText.includes('Annotation Task'), 'the structured task plan is not visible');

    await page.locator('.page-run-button').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('section[aria-label="Agent Activity"] .agent-status-pill')?.textContent?.trim();
      return status === '確認待ち' && document.querySelectorAll('.candidate-section .candidate-list .candidate-card').length === 2;
    }, undefined, { timeout: 45_000 });
    check(await page.getByText('デモ候補です。実モデルの解析結果ではありません。').isVisible(), 'the deterministic demo candidates were not disclosed as demo output');

    await expandDisclosure('.agent-log-details');
    const activityText = await page.locator('section[aria-label="Agent Activity"]').innerText();
    for (const phase of ['計画', 'ページ移動', '読み取り', '検索', '人の確認']) {
      check(activityText.includes(phase), `visible Agent Activity is missing the ${phase} phase`);
    }
    const activityRows = await page.locator('section[aria-label="Agent Activity"] .agent-activity-list > li').allTextContents();
    const visitedPageNumbers = new Set(activityRows.flatMap((row) => [...row.matchAll(/(?:P\.|ページ\s*)(\d+)/g)].map((match) => Number(match[1]))));
    check(visitedPageNumbers.size === 1 && visitedPageNumbers.has(1), `the task should process only page 1; activity showed ${[...visitedPageNumbers].join(', ')}`);

    if (scenario.action === 'correct') {
      await page.waitForFunction((fixture) => {
        const baseKey = `annotation-studio:annotations:${fixture.fileName}`;
        const base = JSON.parse(localStorage.getItem(baseKey) || 'null');
        const state = base?.workspaceKey ? JSON.parse(localStorage.getItem(base.workspaceKey) || 'null') : null;
        return Array.isArray(state?.documentAnnotations) && state.documentAnnotations.some((record) => record.status === 'needs_review');
      }, demo);
      const seededContinuation = await page.evaluate((fixture) => {
        const baseKey = `annotation-studio:annotations:${fixture.fileName}`;
        const base = JSON.parse(localStorage.getItem(baseKey) || 'null');
        const state = base?.workspaceKey ? JSON.parse(localStorage.getItem(base.workspaceKey) || 'null') : null;
        if (!state || !Array.isArray(state.documentAnnotations) || !state.documentAnnotations.some((record) => record.status === 'needs_review')) return false;
        const remainingPages = Array.from({ length: Math.max(0, fixture.pageCount - 1) }, (_, index) => index + 2);
        state.continuation = {
          remainingPages, blockedPage: 1, sourceHash: fixture.sourceHash, fullDocument: true,
          visitedPages: [1], inspectedPages: [1], mode: 'assist',
          instruction: 'Find torque limits and safety requirements on page 1. Ask me when the evidence is uncertain.',
          guidelines: 'Use a concise label, quote the visible passage, and explain why it needs review.',
          correction: '', decisionContext: '', pageDecisionContext: '', humanDecisions: [], lastHumanRuleVersion: 0,
        };
        state.task = { ...state.task, prompt: state.continuation.instruction, guidelines: state.continuation.guidelines, correction: '', mode: 'assist' };
        localStorage.setItem(base.workspaceKey, JSON.stringify(state));
        return true;
      }, demo);
      check(seededContinuation, 'could not prepare a saved multi-page continuation for the correction rule flow');
      await page.reload();
      await waitForRestoredDocument();
      await page.locator('.continuation-note').filter({ hasText: /ページ\s*1/u }).waitFor({ state: 'visible' });
      await page.locator('.rail-settings').click();
      const ruleSettingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
      await ruleSettingsDialog.locator('#api-key').fill('e2e-mock-rule-key-not-a-secret');
      await ruleSettingsDialog.getByRole('button', { name: '設定を閉じる' }).click();
    }

    const candidateCard = page.locator('.candidate-section .candidate-card').filter({ hasText: scenario.candidate }).first();
    await candidateCard.scrollIntoViewIfNeeded();
    if (scenario.action === 'approve') {
      await candidateCard.getByRole('button', { name: '確認して追加' }).click();
    } else if (scenario.action === 'correct') {
      await candidateCard.locator('details.candidate-correction-editor summary').click();
      await candidateCard.locator('details.candidate-correction-editor input').fill(scenario.expectedLabel);
      equal(await candidateCard.locator('details.candidate-correction-editor select').inputValue(), 'item', 'correction scope should remain item-only until the human opts in');
      await candidateCard.getByTestId('draft-correction-rule').click();
      await candidateCard.getByTestId('correction-rule-text').waitFor({ state: 'visible', timeout: 15_000 });
      equal(correctionRuleRequests.length, 1, 'the correction rule planner should be called exactly once');
      equal(correctionRuleRequests[0].input.correction.label, scenario.expectedLabel, 'the draft request omitted the corrected label');
      check(correctionRuleRequests[0].input.sourceCandidate.excerpt.length > 0, 'the draft request omitted source evidence');
      for (const [width, height, name] of [[1440, 900, 'correction-rule-draft-1440x900'], [1280, 720, 'correction-rule-draft-1280x720'], [390, 844, 'correction-rule-draft-390x844']]) {
        await page.setViewportSize({ width, height });
        await candidateCard.locator('.correction-rule-proposal').scrollIntoViewIfNeeded();
        const metrics = await page.evaluate(() => {
          const root = document.querySelector('#root')?.getBoundingClientRect();
          const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
          return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: root?.width ?? 0, shellWidth: shell?.width ?? 0 };
        });
        equal(metrics.rootWidth, width, `${name} application root should span the full viewport`);
        equal(metrics.shellWidth, width, `${name} workspace shell should span the full viewport`);
        check(metrics.scrollWidth <= metrics.clientWidth, `${name} layout has horizontal overflow`);
        check(await candidateCard.getByTestId('correction-rule-text').isVisible(), `${name} layout hides the editable rule proposal`);
        await page.screenshot({ path: `${visualEvidenceDirectory}/${name}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      delayNextCorrectionRule = true;
      await candidateCard.getByTestId('draft-correction-rule').click();
      await delayedCorrectionRuleStarted;
      const correctionLabelInput = candidateCard.locator('details.candidate-correction-editor input');
      await correctionLabelInput.fill(`${scenario.expectedLabel}・確認済み`);
      if (releaseDelayedCorrectionRule) releaseDelayedCorrectionRule();
      await page.waitForTimeout(100);
      equal(await candidateCard.getByTestId('correction-rule-text').count(), 0, 'a stale rule proposal remained visible after the correction changed');
      await correctionLabelInput.fill(scenario.expectedLabel);
      await candidateCard.getByTestId('draft-correction-rule').click();
      await candidateCard.getByTestId('correction-rule-text').waitFor({ state: 'visible', timeout: 15_000 });
      equal(correctionRuleRequests.length, 3, 'the original, stale, and refreshed correction-rule requests should all be recorded');
      const approvedRule = acceptedContinuationRule;
      await candidateCard.getByTestId('correction-rule-text').fill(approvedRule);
      await candidateCard.getByRole('button', { name: 'この案を残りページに適用' }).click();
      equal(await candidateCard.locator('details.candidate-correction-editor select').inputValue(), 'remaining_pages', 'accepting the proposed rule should explicitly opt into later pages');
      await candidateCard.getByRole('button', { name: '変更を反映して続行' }).click();
      const secondCandidate = page.locator('.candidate-section .candidate-card').filter({ hasText: scenario.otherCandidate }).first();
      await secondCandidate.getByRole('button', { name: '確認して追加' }).click();
      await waitUntil(() => ruleContinuationRequests.length >= 2, 'the remaining-page Agent calls did not receive the accepted correction rule');
      check(ruleContinuationRequests.every((request) => String(request.humanDecisions).includes('[RULE FOR REMAINING PAGES] [v1; applies from P.2]') && String(request.humanDecisions).includes(approvedRule)), 'a later-page Agent request omitted the human-approved, versioned rule or its first applicable page');
      await waitUntil(() => validatorRequests.some((request) => String(request.humanDecisions).includes(approvedRule)), 'the completed continuation was not independently validated with its approved rule');
    } else {
      await candidateCard.getByRole('button', { name: '却下' }).click();
    }

    const exportMenu = page.locator('.export-menu');
    await exportMenu.locator('.export-menu-toggle').click();
    await page.getByRole('menuitem', { name: '構造化JSONを保存' }).click();
    await page.waitForFunction(() => typeof window.__visualDocumentE2eExportText === 'string', undefined, { timeout: 15_000 });
    const { filename, serialized } = await page.evaluate(() => ({ filename: window.__visualDocumentE2eExportFilename, serialized: window.__visualDocumentE2eExportText }));
    check(filename.endsWith('-annotations.json'), 'the app did not prepare a named annotation JSON download');
    const exported = JSON.parse(serialized);

    equal(exported.document.fileName, demo.fileName, 'the JSON export references a different document');
    equal(exported.task.mode, 'assist', 'the JSON export omitted the selected review mode');
    check(exported.task.plan && exported.task.plan.title, 'the JSON export omitted the visible task plan');
    equal(exported.reviewQueue.length, scenario.action === 'correct' ? 0 : 1, 'review queue should match the resolved or unresolved candidate state');
    equal(exported.documentAnnotations.filter((record) => record.status === 'needs_review').length, scenario.action === 'correct' ? 0 : 1, 'the canonical pending review status was not exported');

    if (scenario.action === 'approve') {
      equal(exported.annotations.length, 1, 'approval should create one annotation');
      equal(exported.annotations[0].label, scenario.expectedLabel, 'approval changed the candidate label');
      equal(exported.annotations[0].reviewedByHuman, true, 'the approved annotation is not marked as human reviewed');
      equal(exported.annotations[0].source, scenario.expectedSource, 'approval lost its AI source');
      const record = exported.documentAnnotations.find((item) => item.id === exported.annotations[0].id);
      equal(record.status, scenario.expectedStatus, 'the canonical export should preserve approval without marking it as a correction');
      equal(exported.humanRejected.length, 0, 'approval should not create a rejected record');
    } else if (scenario.action === 'correct') {
      equal(exported.annotations.length, 2, 'correction and the second resolved candidate should both remain annotations');
      const correctedAnnotation = exported.annotations.find((annotation) => annotation.label === scenario.expectedLabel);
      check(correctedAnnotation, 'the corrected annotation was not exported');
      equal(correctedAnnotation.reviewedByHuman, true, 'the corrected annotation is not marked as human reviewed');
      equal(correctedAnnotation.source, scenario.expectedSource, 'the corrected annotation should be marked as manual');
      const record = exported.documentAnnotations.find((item) => item.id === correctedAnnotation.id);
      equal(record.status, 'corrected', 'the canonical export should preserve the corrected review status');
      equal(exported.humanRejected.length, 0, 'correction should not create a rejected record');
    } else {
      equal(exported.annotations.length, 0, 'rejection should not create an annotation');
      equal(exported.humanRejected.length, 1, 'the rejected candidate was not preserved in the export');
      equal(exported.humanRejected[0].label, scenario.expectedLabel, 'the wrong candidate was rejected');
      const rejected = exported.documentAnnotations.find((item) => item.id === exported.humanRejected[0].id);
      equal(rejected.status, 'rejected', 'the canonical export did not retain the rejected status');
    }

    outcomes.push(scenario.action);
  }

  const remainingCandidate = page.locator('.candidate-section .candidate-card').filter({ hasText: '安全上の注意' }).first();
  await remainingCandidate.getByRole('button', { name: '確認して追加' }).click();
  await page.waitForFunction(() => {
    const base = JSON.parse(localStorage.getItem('annotation-studio:annotations:demo-specification.pdf') || 'null');
    const state = base?.workspaceKey ? JSON.parse(localStorage.getItem(base.workspaceKey) || 'null') : null;
    return Array.isArray(state?.documentAnnotations) && state.documentAnnotations.some((record) => record.status === 'approved');
  });
  await page.reload();
  await waitForReadyDocument();
  await expandDisclosure('.agent-log-details');
  const runHistoryPanel = page.locator('.run-history-details');
  await runHistoryPanel.waitFor({ state: 'visible', timeout: 10_000 });
  check((await page.locator('.run-history-details > summary').innerText()).includes('過去の作業履歴（1件）'), 'the completed Agent run was not restored from this browser profile');
  await page.locator('.run-history-details > summary').click();
  const restoredRun = page.locator('.run-history-item').first();
  await restoredRun.waitFor({ state: 'visible' });
  await restoredRun.locator('summary').click();
  const restoredRunText = await restoredRun.innerText();
  check(restoredRunText.includes(historyTask), 'the restored run history omitted its original task instruction');
  check(restoredRunText.includes('確認して追加') || restoredRunText.includes('却下'), 'the restored run history omitted saved human decision details');
  check(await restoredRun.locator('.run-history-events > li').count() > 0, 'the restored run history omitted its Agent activity events');
  await page.locator('.export-menu-toggle').click();
  await page.getByRole('menuitem', { name: '作業履歴をJSONで保存' }).click();
  await page.waitForFunction(() => typeof window.__visualDocumentE2eHistoryText === 'string', undefined, { timeout: 15_000 });
  const exportedHistory = await page.evaluate(() => ({ filename: window.__visualDocumentE2eHistoryFilename, serialized: window.__visualDocumentE2eHistoryText }));
  check(exportedHistory.filename.endsWith('-history.json'), 'the app did not prepare the run-history JSON download');
  const historyPayload = JSON.parse(exportedHistory.serialized);
  equal(historyPayload.document.fileName, demo.fileName, 'history export lost its document name');
  equal(historyPayload.runs.length, 1, 'history export should contain this source version\'s single run');
  const exportedRun = historyPayload.runs[0];
  equal(exportedRun.sourceHash, demo.sourceHash, 'history export lost the source-content identity');
  equal(exportedRun.instruction, historyTask, 'history export lost the task instruction');
  check(exportedRun.events.length > 0, 'history export omitted the event log');
  check(exportedRun.humanDecisions?.some((decision) => decision.action === 'reject'), 'history export omitted the rejected decision');
  await restoredRun.locator('summary').click();
  await page.locator('.run-history-details > summary').click();

  const getDemoAnnotationRecords = () => page.evaluate(() => {
    const base = JSON.parse(localStorage.getItem('annotation-studio:annotations:demo-specification.pdf') || 'null');
    const state = base?.workspaceKey ? JSON.parse(localStorage.getItem(base.workspaceKey) || 'null') : null;
    return JSON.stringify(state?.documentAnnotations ?? []);
  });
  const annotationRecordsBeforeValidation = await getDemoAnnotationRecords();
  await page.locator('.rail-settings').click();
  const settingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
  await settingsDialog.locator('#api-key').fill('e2e-mock-key-not-a-secret');
  await settingsDialog.getByRole('button', { name: '設定を閉じる' }).click();
  const annotateRequestsBeforeValidation = requestUrls.filter((url) => url.includes('/api/ai/annotate')).length;
  const agentRunRequestsBeforeValidation = requestUrls.filter((url) => url.includes('/api/agent/run')).length;
  const manualValidatorsBefore = manualValidatorRequests.length;
  await page.getByTestId('rerun-validator').click();
  await page.getByTestId('validator-status').filter({ hasText: 'Validator Agentが' }).waitFor({ state: 'visible', timeout: 15_000 });
  check(await page.getByTestId('validator-findings').innerText().then((text) => text.includes('根拠をもう一度確認してください')), 'manual Validator review findings were not rendered');
  equal(manualValidatorRequests.length, manualValidatorsBefore + 1, 'manual review should make exactly one Validator request');
  check(manualValidatorRequests[manualValidatorsBefore].instruction.length >= 2, 'manual Validator request omitted the current task instruction');
  check(manualValidatorRequests[manualValidatorsBefore].annotations.some((annotation) => annotation.status === 'approved' || annotation.status === 'corrected'), 'manual Validator request omitted saved, human-reviewed annotations');
  equal(requestUrls.filter((url) => url.includes('/api/ai/annotate')).length, annotateRequestsBeforeValidation, 'manual Validator review reran the annotator');
  equal(requestUrls.filter((url) => url.includes('/api/agent/run')).length, agentRunRequestsBeforeValidation, 'manual Validator review restarted the Agent run');
  equal(await getDemoAnnotationRecords(), annotationRecordsBeforeValidation, 'manual Validator review changed saved annotation records or review outcomes');

  const captureValidatorViewport = async (width, height, name) => {
    await page.setViewportSize({ width, height });
    await page.locator('.consistency-panel').scrollIntoViewIfNeeded();
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('#root')?.getBoundingClientRect();
      const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
      return { innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: root?.width ?? 0, shellWidth: shell?.width ?? 0 };
    });
    equal(metrics.rootWidth, width, `${name} application root should span the full viewport`);
    equal(metrics.shellWidth, width, `${name} workspace shell should span the full viewport`);
    check(metrics.scrollWidth <= metrics.clientWidth, `${name} layout has horizontal overflow (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`);
    check(await page.getByTestId('rerun-validator').isVisible(), `${name} layout hides the Validator action`);
    await page.screenshot({ path: `${visualEvidenceDirectory}/${name}.png`, animations: 'disabled' });
  };
  await captureValidatorViewport(1440, 900, 'validator-review-1440x900');
  await captureValidatorViewport(1280, 720, 'validator-review-1280x720');
  await captureValidatorViewport(390, 844, 'validator-review-390x844');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId('rerun-validator').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="validator-status"]')?.textContent?.includes('独立指摘 0件'));
  check(await page.getByText('確認候補は見つかりませんでした。').isVisible(), 'the zero-finding Validator result did not render an explicit empty state');

  delayNextValidation = true;
  await page.getByTestId('rerun-validator').click();
  await delayedValidationStarted;

  const workbookInput = page.locator('.document-toolbar input[type="file"]').first();
  const initialWorkbookConversion = page.waitForResponse((response) => response.url().includes('/api/convert'), { timeout: 20_000 });
  await workbookInput.setInputFiles(workbookFixturePath);
  const initialConversionResponse = await initialWorkbookConversion;
  const initialConversionText = await initialConversionResponse.text();
  check(initialConversionResponse.ok(), `the workbook upload failed with HTTP ${initialConversionResponse.status()}: ${initialConversionText.slice(0, 500)}`);
  const uploadedWorkbookDocument = JSON.parse(initialConversionText);
  await page.locator('#workbook-sheet-preview').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.workbook-grid').waitFor({ state: 'visible' });
  if (releaseDelayedValidation) releaseDelayedValidation();
  await page.waitForTimeout(100);
  equal(await page.locator('.consistency-panel').count(), 0, 'a Validator response for the previous document overwrote the current workbook review state');
  await page.locator('.rail-settings').click();
  const clearSettingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
  await clearSettingsDialog.locator('#api-key').fill('');
  await clearSettingsDialog.getByRole('button', { name: '設定を閉じる' }).click();
  const workbookChanges = await page.evaluate(async ({ convertedDocument }) => {
    const workspace = { documentId: convertedDocument.documentId, sourceHash: convertedDocument.sourceHash };
    const pendingCell = {
      id: 'e2e-wide-cell', documentId: workspace.documentId, sourceHash: workspace.sourceHash,
      target: { kind: 'sheet', sheet: 'Wide', cellRange: 'AQ4' }, label: 'Workbook cell update',
      evidence: 'Fictional source cell for provider-free UI verification.', explanation: 'Compare the source value with the proposed classification.',
      reviewPriority: 'high', status: 'needs_review', note: 'Review the source row.', reason: 'Verify the value before applying.',
      operation: 'write_cell', values: [['pending-proposal']], requiresReview: true, approved: false, rejected: false,
    };
    const pendingSmallRange = {
      id: 'e2e-small-range', documentId: workspace.documentId, sourceHash: workspace.sourceHash,
      target: { kind: 'sheet', sheet: 'Wide', cellRange: 'B10:I14' }, label: 'Workbook range update',
      evidence: 'Fictional source values for bounded review-context verification.', explanation: 'Review every target value before applying.',
      reviewPriority: 'high', status: 'needs_review', note: 'All 40 cells need review.', reason: 'Review the complete matrix.',
      operation: 'write_range', values: Array.from({ length: 5 }, (_, row) => Array.from({ length: 8 }, (_, column) => `proposal-${row + 10}-${column + 2}`)), requiresReview: true, approved: false, rejected: false,
    };
    const pendingLargeRange = {
      id: 'e2e-large-range', documentId: workspace.documentId, sourceHash: workspace.sourceHash,
      target: { kind: 'sheet', sheet: 'Wide', cellRange: 'AW22:BF31' }, label: 'Workbook large range update',
      evidence: 'Fictional source values for paged review verification.', explanation: 'Check each page of the proposed range.',
      reviewPriority: 'high', status: 'needs_review', note: 'Review all 100 cells.', reason: 'Inspect the full range.',
      operation: 'write_range', values: Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, column) => `large-proposal-${row + 22}-${column + 49}`)), requiresReview: true, approved: false, rejected: false,
    };
    const approvedRange = {
      id: 'e2e-approved-range', documentId: workspace.documentId, sourceHash: workspace.sourceHash,
      target: { kind: 'sheet', sheet: 'Wide', cellRange: 'B20:I24' }, label: 'Workbook cell update',
      evidence: 'Fictional approved range for historical context verification.', explanation: 'A resolved change remains inspectable.',
      reviewPriority: 'medium', status: 'approved', note: 'Approved for verification.', reason: 'Preserve the source context.',
      operation: 'write_range', values: Array.from({ length: 5 }, (_, row) => Array.from({ length: 8 }, (_, column) => `approved-${row + 20}-${column + 2}`)), requiresReview: false, approved: true, rejected: false,
    };
    const documentAnnotations = [pendingCell, pendingSmallRange, pendingLargeRange, approvedRange];
    const response = await fetch(`/api/documents/${encodeURIComponent(workspace.documentId)}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'annotations-json', documentAnnotations }),
    });
    if (!response.ok) throw new Error(`Workbook proposal registration failed (${response.status}): ${await response.text()}`);
    await response.arrayBuffer();
    return documentAnnotations.map((record) => ({
      id: record.id, operation: record.operation, sheetName: record.target.sheet,
      range: record.target.cellRange, values: record.values, reason: record.reason,
      reviewPriority: record.reviewPriority, requiresReview: record.status === 'needs_review',
      approved: record.status === 'approved', rejected: record.status === 'rejected',
      ...(record.status === 'approved' || record.status === 'corrected' ? { reviewOutcome: record.status } : {}),
    }));
  }, { convertedDocument: uploadedWorkbookDocument });

  await page.route('**/api/ai/annotate', async (route) => {
    mockedAgentRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'complete', annotations: [], spreadsheetChanges: workbookChanges, toolEvents: [], visitedPages: [1] }),
    });
  });
  await page.getByRole('tab', { name: /Agent/ }).click();
  await page.locator('#ai-prompt').fill('Review the flagged workbook cells and confirm their original values.');
  await page.getByRole('button', { name: 'Excelを分類' }).click();
  await page.locator('.workbook-change').filter({ hasText: 'AQ4' }).waitFor({ state: 'visible', timeout: 30_000 });

  const wideCellCard = page.locator('.workbook-change').filter({ hasText: 'AQ4' });
  await wideCellCard.getByRole('button', { name: '表で位置を見る' }).click();
  await page.locator('.workbook-column-page-control').getByText(/AG–AV/).waitFor({ state: 'visible' });
  check(await page.locator('.workbook-grid thead').innerText().then((text) => text.includes('AQ')), 'the column jump did not show the proposed target at AQ4');
  check(await page.locator('.workbook-grid').innerText().then((text) => text.includes('pending-proposal')), 'the wide-sheet cell proposal was not highlighted in the central grid');

  const smallRangeCard = page.locator('.workbook-change').filter({ hasText: 'B10:I14' });
  await smallRangeCard.getByRole('button', { name: '変更前と提案を表示' }).click();
  const smallContext = smallRangeCard.locator('.workbook-context-preview');
  await smallContext.waitFor({ state: 'visible' });
  check(await smallContext.innerText().then((text) => text.includes('B10:I14')), 'the single context window omitted the complete small range');
  equal(await smallContext.locator('.workbook-context-table-wrap tbody tr').count(), 5, 'the small range context is missing target rows');
  equal(await smallContext.locator('.workbook-context-table-wrap tbody tr').last().locator('td').count(), 8, 'the small range context is missing its final target columns');
  check(await smallContext.innerText().then((text) => text.includes('source-14-9') && text.includes('proposal-14-9')), 'the small range context did not show the last original value and proposal');

  const largeRangeCard = page.locator('.workbook-change').filter({ hasText: 'AW22:BF31' });
  await largeRangeCard.getByRole('button', { name: '変更前と提案を表示' }).click();
  const largeContext = largeRangeCard.locator('.workbook-context-preview');
  await largeContext.waitFor({ state: 'visible' });
  await largeContext.getByText(/1 \/ 4/).waitFor({ state: 'visible' });
  await largeContext.getByRole('button', { name: '次へ' }).click();
  await largeContext.getByText(/2 \/ 4/).waitFor({ state: 'visible' });
  check(await largeContext.innerText().then((text) => text.includes('large-proposal-22-57')), 'the second page did not show its original-source proposal value');

  const approvedRangeCard = page.locator('.workbook-change').filter({ hasText: 'B20:I24' });
  await approvedRangeCard.getByRole('button', { name: '変更前と提案を表示' }).click();
  const approvedContext = approvedRangeCard.locator('.workbook-context-preview');
  await approvedContext.waitFor({ state: 'visible' });
  check(await approvedContext.innerText().then((text) => text.includes('source-24-9') && text.includes('approved-24-9')), 'approved changes should retain read-only original-value context');
  await wideCellCard.getByRole('button', { name: '承認して反映' }).waitFor({ state: 'visible' });
  await wideCellCard.getByRole('button', { name: '承認して反映' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workbook-change')].some((item) => item.textContent?.includes('AQ4') && item.textContent.includes('承認済み')));
  const directDecision = await page.evaluate(async ({ documentId, changeId }) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/workbook`);
    if (!response.ok) throw new Error(`Workbook status lookup failed (${response.status}).`);
    const workbook = await response.json();
    return workbook.changes.find((change) => change.id === changeId);
  }, { documentId: uploadedWorkbookDocument.documentId, changeId: 'e2e-wide-cell' });
  check(directDecision?.approved === true && directDecision.requiresReview === false && directDecision.reviewOutcome === 'approved', 'the unbound spreadsheet approval did not persist as a human decision');
  await largeRangeCard.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.waitForTimeout(4_500);
  await page.screenshot({ path: `${visualEvidenceDirectory}/excel-range-review-1440x1024.png` });

  const changedSourceInput = page.locator('.document-toolbar input[type="file"]').first();
  const changedSourceConversion = page.waitForResponse((response) => response.url().includes('/api/convert'), { timeout: 20_000 });
  await changedSourceInput.setInputFiles(changedSourcePdfPath);
  const changedSourceResponse = await changedSourceConversion;
  const changedSourceText = await changedSourceResponse.text();
  check(changedSourceResponse.ok(), `same-name changed-source upload failed with HTTP ${changedSourceResponse.status()}: ${changedSourceText.slice(0, 500)}`);
  const changedSourceDocument = JSON.parse(changedSourceText);
  equal(changedSourceDocument.fileName, demo.fileName, 'the isolation fixture must keep the original filename');
  check(changedSourceDocument.sourceHash !== demo.sourceHash, 'the isolation fixture did not change the source hash');
  await page.getByRole('tab', { name: /Agent/ }).click();
  try {
    await waitForReadyDocument();
  } catch (error) {
    const visibleText = await page.locator('body').innerText().catch(() => '(body unavailable)');
    fail(`the same-name changed-source PDF did not become the active document: ${String(error)}; page text=${visibleText.slice(0, 1200)}`);
  }
  equal(await page.locator('.run-history-details').count(), 0, 'same-name content with a new source hash exposed history from the previous document version');
  equal(await page.locator('.candidate-section .candidate-card').count(), 0, 'same-name content with a new source hash exposed old review candidates');
  equal(manualValidatorRequests.length, 3, 'finding, empty, and stale-response manual Validator scenarios should all run before folder processing');

  const folderInput = page.locator('.document-toolbar input[type="file"]').nth(1);
  await folderInput.setInputFiles(folderFixtureDirectory);
  await page.locator('.workspace-project-content h2').waitFor({ state: 'visible', timeout: 20_000 });
  equal(await page.locator('.workspace-document-item').count(), 3, 'the browser folder import should include only its supported PDF, XLSX, and image files');
  const folderPdfItem = page.locator('.workspace-document-item').filter({ hasText: '01 Safety.pdf' });
  const folderXlsxItem = page.locator('.workspace-document-item').filter({ hasText: '02 Workbook.xlsx' });
  const folderImageItem = page.locator('.workspace-document-item').filter({ hasText: '03 Inspection photo.png' });
  check(await folderPdfItem.count() === 1 && await folderXlsxItem.count() === 1 && await folderImageItem.count() === 1, 'the imported folder is missing one of its supported formats');
  await folderImageItem.locator('input[type="checkbox"]').uncheck();
  check((await page.locator('.workspace-selection-actions').innerText()).includes('2 / 3'), 'folder subset selection did not leave exactly two documents checked');
  await page.getByRole('tab', { name: /Agent/ }).click();
  await page.locator('#ai-prompt').fill('Review selected project documents and ask me about the first ambiguous safety finding.');
  await page.locator('.rail-settings').click();
  const folderSettingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
  await folderSettingsDialog.locator('#api-key').fill('e2e-mock-folder-key-not-a-secret');
  await folderSettingsDialog.getByRole('button', { name: '設定を閉じる' }).click();
  await page.getByRole('tab', { name: /プロジェクト/ }).click();
  await page.unroute('**/api/ai/annotate');
  folderBatchMode = true;
  folderBatchRequestCount = 0;
  folderBatchRequests.length = 0;
  await page.locator('.workspace-run-button').click();
  await page.waitForFunction(() => {
    const progress = document.querySelector('.workspace-progress')?.textContent ?? '';
    return progress.includes('プロジェクトを処理しました') && progress.includes('2 / 2');
  }, undefined, { timeout: 60_000 });
  folderBatchMode = false;
  equal(new Set(folderBatchRequests.map((request) => request.documentId)).size, 2, 'the selected PDF and XLSX should execute while the unchecked image is skipped');
  check(folderBatchRequestCount >= 2, 'the selected folder documents should each run at least one page request');
  const batchText = await page.locator('body').innerText();
  check(batchText.includes('対象 2件、確認待ち 2件、失敗 0件'), `the batch summary did not count the PDF candidate and uncertain workbook change: ${batchText.slice(-1200)}`);
  await page.getByRole('tab', { name: /プロジェクト/ }).click();
  check((await folderPdfItem.innerText()).includes('確認待ち'), 'the reviewed PDF was not marked as awaiting review in the project list');
  check((await folderXlsxItem.innerText()).includes('確認待ち'), 'the uncertain XLSX change was not marked for review in the project list');
  check((await folderImageItem.innerText()).includes('未実行'), 'the unchecked image was processed by the selected subset batch');

  await waitForWorkspaceDocumentEnabled('02 Workbook.xlsx');
  const folderXlsxRelativePath = await folderXlsxItem.locator('.workspace-document-open strong').innerText();
  await folderXlsxItem.locator('.workspace-document-open').click();
  await page.getByRole('tab', { name: /Agent/ }).click();
  await waitForWorkspaceDocumentOpen(folderXlsxRelativePath, true);
  const batchWorkbookChange = page.locator('.workbook-change').filter({ hasText: 'Wide!B2' });
  await batchWorkbookChange.waitFor({ state: 'visible', timeout: 15_000 });
  check((await batchWorkbookChange.innerText()).includes('HIGH') && (await batchWorkbookChange.innerText()).includes('承認待ち'), 'the uncertain batched workbook value was automatically applied instead of retained for review');
  await page.getByRole('tab', { name: /プロジェクト/ }).click();

  const folderPdfRelativePath = await folderPdfItem.locator('.workspace-document-open strong').innerText();
  await waitForWorkspaceDocumentEnabled('01 Safety.pdf');
  await folderPdfItem.locator('.workspace-document-open').click();
  await waitForWorkspaceDocumentOpen(folderPdfRelativePath);
  const restoredFolderCandidate = page.locator('.candidate-section .candidate-card').filter({ hasText: 'FOLDER BATCH REVIEW' });
  await restoredFolderCandidate.waitFor({ state: 'visible', timeout: 15_000 });
  await restoredFolderCandidate.getByRole('button', { name: '確認して追加' }).click();
  await page.waitForTimeout(250);
  const folderWorkspaceStorage = await page.evaluate((relativePath) => {
    const key = `annotation-studio:annotations:${relativePath}`;
    return { key, base: localStorage.getItem(key), keys: Object.keys(localStorage).filter((item) => item.includes('annotation-studio:annotations:')) };
  }, folderPdfRelativePath);
  check(Boolean(folderWorkspaceStorage.base && JSON.parse(folderWorkspaceStorage.base).workspaceKey), `the folder-relative document workspace did not persist its resolved review decision; path=${folderPdfRelativePath}; storage=${JSON.stringify(folderWorkspaceStorage)}`);
  await page.getByRole('tab', { name: /プロジェクト/ }).click();
  const folderJsonExport = page.getByRole('button', { name: /01 Safety\.pdfの注釈JSONを保存/ });
  await folderJsonExport.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => { delete window.__visualDocumentE2eExportText; });
  expireNextWorkspaceExport = true;
  captureWorkspaceRecovery = true;
  await folderJsonExport.click();
  await page.waitForFunction(() => typeof window.__visualDocumentE2eExportText === 'string', undefined, { timeout: 15_000 });
  captureWorkspaceRecovery = false;
  const folderExport = JSON.parse(await page.evaluate(() => window.__visualDocumentE2eExportText));
  equal(folderExport.document.fileName, folderPdfRelativePath, 'the folder document export used the wrong relative file name');
  equal(folderExport.documentAnnotations.length, 1, 'the folder-relative export omitted the reviewed document annotation');
  equal(folderExport.documentAnnotations[0].status, 'approved', 'the folder-relative export did not retain its human review outcome');
  equal(workspaceRecoveryConversions, 1, 'an expired workspace export did not reopen its connected source file once');
  check(expiredWorkspaceDocumentId && recoveredWorkspaceDocumentId && expiredWorkspaceDocumentId !== recoveredWorkspaceDocumentId, 'workspace export recovery did not rebind saved records to the new server session');

  const pdfSelection = folderPdfItem.locator('input[type="checkbox"]');
  const xlsxSelection = folderXlsxItem.locator('input[type="checkbox"]');
  const imageSelection = folderImageItem.locator('input[type="checkbox"]');
  if (await pdfSelection.isChecked()) await pdfSelection.uncheck();
  if (await xlsxSelection.isChecked()) await xlsxSelection.uncheck();
  if (!(await imageSelection.isChecked())) await imageSelection.check();
  folderBatchMode = true;
  folderBatchRequestCount = 0;
  folderBatchRequests.length = 0;
  await page.locator('.workspace-run-button').click();
  await page.waitForFunction(() => {
    const progress = document.querySelector('.workspace-progress')?.textContent ?? '';
    return progress.includes('プロジェクトを処理しました') && progress.includes('1 / 1');
  }, undefined, { timeout: 60_000 });
  folderBatchMode = false;
  equal(folderBatchRequestCount, 1, 'the selected raster image should receive one visual Agent request');
  check(await page.locator('.document-page-image').isVisible(), 'the folder image was not rendered in the page viewer');
  const imageCandidate = page.locator('.candidate-section .candidate-card').filter({ hasText: 'FOLDER BATCH REVIEW' });
  await imageCandidate.waitFor({ state: 'visible', timeout: 15_000 });
  await imageCandidate.getByRole('button', { name: '確認して追加' }).click();
  await page.getByRole('tab', { name: /プロジェクト/ }).click();
  const imageRelativePath = await folderImageItem.locator('.workspace-document-open strong').innerText();
  const imageJsonExport = page.getByRole('button', { name: /03 Inspection photo\.pngの注釈JSONを保存/ });
  await imageJsonExport.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => { delete window.__visualDocumentE2eExportText; });
  await imageJsonExport.click();
  await page.waitForFunction(() => typeof window.__visualDocumentE2eExportText === 'string', undefined, { timeout: 15_000 });
  const imageExport = JSON.parse(await page.evaluate(() => window.__visualDocumentE2eExportText));
  equal(imageExport.document.fileName, imageRelativePath, 'the image document export lost its folder-relative name');
  equal(imageExport.documentAnnotations.length, 1, 'the image upload path did not preserve its reviewed annotation');
  equal(imageExport.documentAnnotations[0].status, 'approved', 'the image annotation export omitted the human decision');

  for (const office of [
    { mode: 'docx', path: officeDocxFixturePath, fileName: 'office-review.docx', menuLabel: '注釈付きWordを保存', expectedDownload: 'office-review-annotated.docx' },
    { mode: 'pptx', path: officePptxFixturePath, fileName: 'office-roadmap.pptx', menuLabel: '注釈付きPowerPointを保存', expectedDownload: 'office-roadmap-annotated.pptx' },
  ]) {
    const officeConversion = page.waitForResponse((response) => response.url().includes('/api/convert'), { timeout: 20_000 });
    await page.locator('.document-toolbar input[type="file"]').first().setInputFiles(office.path);
    const officeResponse = await officeConversion;
    const officeText = await officeResponse.text();
    check(officeResponse.ok(), `${office.fileName} upload failed with HTTP ${officeResponse.status()}: ${officeText.slice(0, 500)}`);
    const uploadedOfficeDocument = JSON.parse(officeText);
    equal(uploadedOfficeDocument.fileName, office.fileName, `${office.mode.toUpperCase()} upload changed the source filename`);
    equal(uploadedOfficeDocument.fileType.toLowerCase(), office.mode, `${office.mode.toUpperCase()} upload selected the wrong document adapter`);
    await page.getByRole('tab', { name: /Agent/ }).click();
    await page.locator('#ai-prompt').fill(office.mode === 'docx' ? 'Mark the exact termination clause in this Word document.' : 'Classify the main product-roadmap slide.');
    officeAnnotationMode = office.mode;
    await page.locator('.page-run-button').click();
    await waitUntil(() => officeAnnotationRequests.some((request) => request.mode === office.mode), `${office.mode.toUpperCase()} task did not reach the provider-free annotation fixture`);
    officeAnnotationMode = null;
    equal(officeAnnotationRequests.filter((request) => request.mode === office.mode).length, 1, `${office.mode.toUpperCase()} task did not use the provider-free annotation fixture`);
    await page.locator('.export-menu-toggle').click();
    const nativeOfficeExport = page.getByRole('menuitem', { name: office.menuLabel, exact: true });
    await nativeOfficeExport.waitFor({ state: 'visible' });
    await waitUntil(() => nativeOfficeExport.isEnabled(), `${office.mode.toUpperCase()} native export stayed disabled after a clear finding was applied`);
    await page.evaluate(() => { delete window.__visualDocumentE2eOfficeExportFilename; delete window.__visualDocumentE2eOfficeExportByteLength; delete window.__visualDocumentE2eOfficeExportPromise; });
    await nativeOfficeExport.click();
    await page.waitForFunction(() => Boolean(window.__visualDocumentE2eOfficeExportPromise), undefined, { timeout: 20_000 });
    const officeExport = await page.evaluate(async () => ({ fileName: window.__visualDocumentE2eOfficeExportFilename, byteLength: await window.__visualDocumentE2eOfficeExportPromise }));
    equal(officeExport.fileName, office.expectedDownload, `${office.mode.toUpperCase()} native export used the wrong filename`);
    check(officeExport.byteLength > 0, `${office.mode.toUpperCase()} native export returned an empty Office package`);
  }

  await page.locator('.rail-settings').click();
  const navigationSettingsDialog = page.getByRole('dialog', { name: '接続と使用量' });
  await navigationSettingsDialog.locator('#provider-mode').selectOption('openai-compatible');
  await navigationSettingsDialog.locator('#ai-endpoint').fill('https://mock-provider.invalid/v1');
  await navigationSettingsDialog.locator('#api-key').fill('');
  await navigationSettingsDialog.getByRole('button', { name: '設定を閉じる' }).click();
  const navigationSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('annotation-studio:settings:v1') || 'null'));
  check(navigationSettings?.provider === 'openai-compatible' && navigationSettings.endpoint === 'https://mock-provider.invalid/v1', `the navigation E2E provider setup was not retained: ${JSON.stringify(navigationSettings)}`);
  check((await page.locator('.rail-settings').innerText()).includes('AI接続中'), 'the saved mock provider endpoint did not configure the navigation test session');
  const navigationConversion = page.waitForResponse((response) => response.url().includes('/api/convert'), { timeout: 20_000 });
  await page.locator('.document-toolbar input[type="file"]').first().setInputFiles(navigationPdfFixturePath);
  const navigationResponse = await navigationConversion;
  check(navigationResponse.ok(), `the multi-page navigation fixture failed to load with HTTP ${navigationResponse.status()}`);
  const navigationDocument = JSON.parse(await navigationResponse.text());
  check(navigationDocument.pageCount >= 3, 'the navigation fixture must contain at least three pages');
  await page.getByRole('tab', { name: /Agent/ }).click();
  await page.locator('#ai-prompt').fill('Inspect the entire document, zoom into the relevant passage, and highlight your evidence.');
  agentNavigationViewportMode = true;
  await page.getByRole('button', { name: '全ページを実行', exact: true }).click();
  const navigationSegmentDeadline = Date.now() + 30_000;
  while (agentNavigationRequests.length < 2 && Date.now() < navigationSegmentDeadline) await page.waitForTimeout(100);
  equal(agentNavigationRequests.length, 2, 'the first bounded Agent segment did not start a second full-document navigation segment');
  try {
    await page.waitForFunction(() => document.querySelector('section[aria-label="Agent Activity"]')?.innerText.includes('inspect_page → Inspected page 12 for task evidence.'), undefined, { timeout: 10_000 });
  } catch (error) {
    const activity = await page.locator('section[aria-label="Agent Activity"]').innerText().catch(() => '(activity unavailable)');
    fail(`the first segment's final page inspection was not streamed before segment two: ${String(error)}; navigationRequests=${agentNavigationRequests.length}; firstRequest=${JSON.stringify(agentNavigationRequests[0] ?? null)}; activity=${activity.slice(-1600)}`);
  }
  const firstSegmentActivityText = await page.locator('section[aria-label="Agent Activity"]').innerText();
  check(firstSegmentActivityText.includes('inspect_page → Inspected page 12 for task evidence.'), 'the first navigation segment did not stream its final page inspection before continuing');
  const liveActivityStrip = page.locator('.agent-live-activity');
  await liveActivityStrip.waitFor({ state: 'visible', timeout: 10_000 });
  const liveActivityBounds = await liveActivityStrip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: document.documentElement.clientHeight, text: element.textContent ?? '' };
  });
  check(liveActivityBounds.bottom > 0 && liveActivityBounds.top < liveActivityBounds.viewportHeight, `the live Agent activity strip is not inside the visible app viewport: ${JSON.stringify(liveActivityBounds)}`);
  check(liveActivityBounds.text.trim().length > 0, 'the visible live Agent activity strip has no current event text');
  await page.screenshot({ path: `${visualEvidenceDirectory}/agent-live-activity-1440x900.png`, animations: 'disabled' });
  releaseSecondAgentNavigationSegment();
  try {
    await page.getByRole('button', { name: 'NAVIGATION STREAM TARGET、ページ 2' }).waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const activity = await page.locator('section[aria-label="Agent Activity"]').innerText().catch(() => '(activity unavailable)');
    const pageState = await page.evaluate(() => ({
      pageAlt: document.querySelector('.document-page-image')?.getAttribute('alt') ?? '',
      viewerClass: document.querySelector('.page-scroll-area')?.className ?? '',
      scrollTop: document.querySelector('.page-scroll-area')?.scrollTop ?? 0,
      annotations: [...document.querySelectorAll('.annotation-box')].map((element) => element.getAttribute('aria-label')),
    }));
    fail(`the streamed page-2 finding was not visible: ${String(error)}; AgentRequests=${mockedAgentRequestCount}; navigationRequests=${agentNavigationRequests.length}; providerLabel=${await page.locator('.rail-settings').innerText().catch(() => '(unavailable)')}; routedRequests=${JSON.stringify(requestUrls.filter((url) => url.includes('/api/ai/annotate')))}; pageState=${JSON.stringify(pageState)}; activity=${activity.slice(-1200)}`);
  }
  await page.waitForFunction(() => {
    const image = document.querySelector('.document-page-image');
    const viewer = document.querySelector('.page-scroll-area');
    return image?.getAttribute('alt')?.includes('2 ページ')
      && viewer?.classList.contains('is-agent-viewport')
      && viewer.scrollTop > 0;
  }, undefined, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('section[aria-label="Agent Activity"] .agent-status-pill')?.textContent?.trim() === '完了', undefined, { timeout: 20_000 });
  agentNavigationViewportMode = false;
  equal(agentNavigationRequests.length, 2, 'a partial first navigation segment should continue in a second full-document Agent segment');
  equal(agentNavigationRequests[0].documentScope, 'all', 'the run did not request the entire document from its opening page');
  equal(agentNavigationRequests[1].documentScope, 'all', 'the remaining navigation segment fell back to a page-scoped Agent request');
  equal(agentNavigationRequests[1].pageNumber, 2, 'the next Agent segment did not return to the first opened-but-uninspected page');
  equal(JSON.stringify(agentNavigationRequests[1].alreadyInspectedPages), JSON.stringify([1, ...Array.from({ length: 10 }, (_, index) => index + 3)]), 'the next Agent segment included a page that had only been opened in its inspected-page checkpoint');
  const navigationBox = page.locator('.annotation-box').filter({ hasText: 'NAVIGATION STREAM TARGET' });
  equal(await navigationBox.count(), 1, 'the returned page-2 annotation was not drawn over the document page');
  const navigationBoxLabel = await navigationBox.getAttribute('aria-label');
  check(navigationBoxLabel?.includes('NAVIGATION STREAM TARGET') && navigationBoxLabel.includes('ページ 2'), 'the highlight overlay does not identify the page-2 finding');
  const navigationViewer = await page.evaluate(() => {
    const viewer = document.querySelector('.page-scroll-area');
    const frame = document.querySelector('.page-frame-wrap');
    return { page: document.querySelector('.document-page-image')?.getAttribute('alt') ?? '', viewport: viewer?.className ?? '', scrollTop: viewer?.scrollTop ?? 0, zoom: frame?.style.getPropertyValue('--zoom') ?? '' };
  });
  check(navigationViewer.zoom.length > 0 && navigationViewer.scrollTop > 0, `scroll_document did not focus the viewer on a bounded crop: ${JSON.stringify(navigationViewer)}`);
  await expandDisclosure('.agent-log-details');
  const navigationActivityText = await page.locator('section[aria-label="Agent Activity"]').innerText();
  check(navigationActivityText.includes('navigate_page → Returned to page 2 to finish with the evidence highlight.'), 'the streamed page navigation activity was not rendered');
  check(navigationActivityText.includes('scroll_document → Focused the viewer on the highlighted passage.'), 'the final detailed viewport action was not rendered after the second navigation segment');
  await page.screenshot({ path: `${visualEvidenceDirectory}/agent-navigation-stream-1440x900.png`, animations: 'disabled' });

  await page.locator('.agent-mode-grid').getByRole('button', { name: /Autopilot/ }).click();
  await page.locator('#ai-prompt').fill('Classify every page and report important findings; ask only when evidence is unclear.');
  await page.getByRole('button', { name: 'Autopilotを開始' }).click();
  await page.getByRole('status').filter({ hasText: '高優先度の重要項目1件を報告しました' }).waitFor({ state: 'visible', timeout: 25_000 });
  await expandDisclosure('.agent-log-details');
  equal(await page.locator('section[aria-label="Agent Activity"] .agent-status-pill').innerText(), '完了', 'Autopilot should complete after the checked full-document pass');
  equal(autopilotRequests.length, 1, 'Autopilot did not send a single full-document run request');
  equal(autopilotRequests[0].agentMode, 'autopilot', 'Autopilot mode did not reach the document Agent request');
  equal(autopilotRequests[0].documentScope, 'all', 'Autopilot did not process the full document');
  check(await page.getByRole('button', { name: /AUTOPILOT IMPORTANT/ }).isVisible(), 'a clear high-priority Autopilot result was not shown as an applied annotation');
  check(await page.locator('.candidate-section .candidate-card').count() === 0, 'a clear high-priority Autopilot result incorrectly waited for human review');
  await page.screenshot({ path: `${visualEvidenceDirectory}/autopilot-important-report-1440x900.png`, animations: 'disabled' });

  await page.locator('.agent-mode-grid').getByRole('button', { name: /Assist/ }).click();
  await page.locator('#ai-prompt').fill('Inspect this page and report any conversion warning.');
  coverageWarningMode = true;
  await page.locator('.page-run-button').click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="Agent Activity"] .agent-status-pill')?.textContent?.trim() === '確認待ち', undefined, { timeout: 20_000 });
  coverageWarningMode = false;
  equal(coverageWarningRequests.length, 1, 'the converter-warning coverage scenario did not run exactly once');
  equal(coverageWarningRequests[0].documentScope, 'current', 'the warning acknowledgement fixture should be page-scoped');
  await expandDisclosure('.agent-log-details');
  await page.locator('.run-history-details > summary').click();
  const warningRun = page.locator('.run-history-item').first();
  await warningRun.locator('summary').click();
  const warningAcknowledgement = warningRun.getByRole('button', { name: '変換警告を確認済みにする' });
  await warningAcknowledgement.waitFor({ state: 'visible', timeout: 10_000 });
  await warningAcknowledgement.click();
  await page.waitForFunction(() => document.querySelector('.run-history-item summary')?.textContent?.includes('完了'), undefined, { timeout: 15_000 });
  equal(await page.locator('section[aria-label="Agent Activity"] .agent-status-pill').innerText(), '完了', 'the workbench status should update after acknowledging the final coverage warning');
  check((await warningRun.locator('.run-page-coverage-summary').innerText()).includes('変換警告を人が確認済み 1ページ'), 'the saved run did not retain the warning acknowledgement');
  check(await warningRun.getByText('変換警告を人が確認済みとして記録しました。').isVisible(), 'the warning acknowledgement was not shown on its page coverage entry');
  await page.screenshot({ path: `${visualEvidenceDirectory}/page-coverage-warning-ack-1440x900.png`, animations: 'disabled' });

  const aiRequests = requestUrls.filter((url) => /\/api\/(?:ai|codex)\//i.test(url));
  check(aiRequests.every((url) => /\/api\/ai\/(?:annotate|validate|plan|correction-rule)(?:\?|$)/i.test(url)), `the browser attempted a non-mocked AI endpoint: ${aiRequests.join(', ')}`);
  equal(aiRequests.filter((url) => /\/api\/ai\/annotate(?:\?|$)/i.test(url)).length, mockedAgentRequestCount, 'each annotation Agent request should have been intercepted by the provider-free fixture');
  check(manualValidatorRequests.length >= 3, 'the three manual Validator interactions were not retained after folder processing');
  equal(coverageWarningRequests.length, 1, 'human acknowledgement of a persistent page warning was not verified');
  equal(ruleContinuationRequests.length, 2, 'both remaining-page Agent calls should receive the explicitly accepted rule');
  equal(correctionRuleRequests.length, 3, 'the initial, stale, and refreshed correction-rule requests should all be mocked');
  check(planRequests.every((request) => typeof request.instruction === 'string' && request.instruction.length >= 2), 'a mocked Planner request omitted its task instruction');
  equal(externalRequests.length, 0, `the browser attempted non-local network requests: ${externalRequests.join(', ')}`);
  equal(expectedWorkspaceExpiryConsoleErrors.length, 1, 'the intentional expired-session response should be the only ignored browser resource error');
  equal(consoleErrors.length, 0, `the browser reported console errors: ${consoleErrors.join(' | ')}`);
  return `Contract review demo passed: optional two-page fictional PDF, six termination clauses, one scripted ambiguous review candidate, human approval, and persistent no-model disclosure; Live contract LLM demo passed: separate unlabeled eleven-page PDF with fourteen clauses, Autopilot preselection, model-connection gate, and no scripted results; Customer feedback LLM demo passed: 16 blank synthetic records, live-model-only run guard, full-width worksheet preview, and no scripted annotations; four visible modes; PDF review and continuation; run-history reload/export/source isolation; streamed Agent navigation and viewport-to-highlight interaction with the current activity visibly inside the production viewport and page-2 evidence focus; Autopilot applied and reported a clear high-priority result; a reviewer acknowledgement completed a persistent converter-warning coverage item; mixed folder batch with expired-session export recovery; DOCX/PPTX upload, annotation, and native export; read-only Validator recheck; and XLSX column jump/context paging passed with no external provider calls or unexpected browser console errors`;
}
