async (page) => {
  const fail = (message) => { throw new Error(`Browser E2E assertion failed: ${message}`); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const equal = (actual, expected, message) => {
    if (actual !== expected) fail(`${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const demo = await page.evaluate(() => JSON.parse(document.body.textContent || 'null'));
  check(demo && demo.demo === true, 'the built-in demo document did not load');
  check(demo.fileName === 'demo-specification.pdf', 'the built-in fictional PDF was not selected');
  check(typeof demo.documentId === 'string' && /^[\da-f-]{36}$/i.test(demo.documentId), 'the demo document session ID is missing');
  check(typeof demo.sourceHash === 'string' && /^[\da-f]{64}$/i.test(demo.sourceHash), 'the demo source hash is missing');
  check(demo.pageCount >= 1, 'the demo PDF has no pages');

  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  equal(health.aiConfigured, false, 'the provider-free API unexpectedly reports configured credentials');
  equal(health.codexAppServerConfigured, false, 'the Codex App Server provider must be disabled');

  const consoleErrors = [];
  const requestUrls = [];
  const externalRequests = [];
  const currentUrl = page.url();
  const origin = currentUrl.slice(0, currentUrl.indexOf('/api/demo'));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('request', (request) => requestUrls.push(request.url()));
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl !== origin && !requestUrl.startsWith(`${origin}/`)) {
      externalRequests.push(requestUrl);
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.addInitScript((fixture) => {
    localStorage.clear();
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

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
      if (this.download?.endsWith('-annotations.json')) {
        window.__visualDocumentE2eExport = fetch(this.href).then((response) => response.text());
      }
      return originalClick.apply(this, args);
    };
  }, demo);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);

  const scenarios = [
    { action: 'approve', candidate: '制限値', expectedLabel: '制限値', expectedSource: 'ai', expectedStatus: 'approved' },
    { action: 'correct', candidate: '安全上の注意', expectedLabel: '人が修正した安全基準', expectedSource: 'manual', expectedStatus: 'corrected' },
    { action: 'reject', candidate: '制限値', expectedLabel: '制限値' },
  ];
  const outcomes = [];

  const waitForReadyDocument = async () => {
    await page.getByRole('heading', { name: 'Visual Document Work Agent', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#ai-prompt').waitFor({ state: 'visible' });
    await page.locator('.document-page-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const image = document.querySelector('.document-page-image');
      const runButton = document.querySelector('.page-run-button');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && runButton && !runButton.disabled;
    });
  };

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    if (index > 0) await page.reload();
    await waitForReadyDocument();
    equal(await page.locator('.candidate-section .candidate-card').count(), 0, 'the clean E2E workspace should start without annotations or candidates');
    equal(await page.locator('.agent-mode-grid button').filter({ hasText: 'Assist' }).getAttribute('aria-pressed'), 'true', 'Assist mode should be selected for human review');

    await page.locator('#ai-prompt').fill('Find torque limits and safety requirements on page 1. Ask me when the evidence is uncertain.');
    await page.locator('#annotation-guidelines').fill('Use a concise label, quote the visible passage, and explain why it needs review.');
    await page.getByRole('button', { name: '指示をTaskに整理' }).click();
    const planCard = page.getByRole('region', { name: 'Annotation Task Plan' });
    await planCard.waitFor({ state: 'visible' });
    const planText = await planCard.innerText();
    check(planText.includes('ローカル下書き'), 'the plan was not visibly produced by the provider-free local planner');
    check(planText.includes('Annotation Task'), 'the structured task plan is not visible');

    await page.locator('.page-run-button').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('section[aria-label="Agent Activity"] .agent-status-pill')?.textContent?.trim();
      return status === 'Waiting' && document.querySelectorAll('.candidate-section .candidate-list .candidate-card').length === 2;
    }, undefined, { timeout: 45_000 });
    check(await page.getByText('デモ候補です。実モデルの解析結果ではありません。').isVisible(), 'the deterministic demo candidates were not disclosed as demo output');

    const activityText = await page.locator('section[aria-label="Agent Activity"]').innerText();
    for (const phase of ['Planning', 'Navigating', 'Reading', 'Searching', 'Asking']) {
      check(activityText.includes(phase), `visible Agent Activity is missing the ${phase} phase`);
    }
    const activityRows = await page.locator('section[aria-label="Agent Activity"] .agent-activity-list > li').allTextContents();
    const visitedPageNumbers = new Set(activityRows.flatMap((row) => [...row.matchAll(/P\.(\d+)/g)].map((match) => Number(match[1]))));
    check(visitedPageNumbers.size === 1 && visitedPageNumbers.has(1), `the task should process only page 1; activity showed ${[...visitedPageNumbers].join(', ')}`);

    const candidateCard = page.locator('.candidate-section .candidate-card').filter({ hasText: scenario.candidate }).first();
    await candidateCard.scrollIntoViewIfNeeded();
    if (scenario.action === 'approve') {
      await candidateCard.getByRole('button', { name: '確認して追加' }).click();
    } else if (scenario.action === 'correct') {
      await candidateCard.locator('details.candidate-correction-editor summary').click();
      await candidateCard.locator('details.candidate-correction-editor input').fill(scenario.expectedLabel);
      await candidateCard.getByRole('button', { name: '変更を反映して続行' }).click();
    } else {
      await candidateCard.getByRole('button', { name: '却下' }).click();
    }

    const exportMenu = page.locator('.export-menu');
    await exportMenu.hover();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '構造化JSONを保存' }).click();
    const download = await downloadPromise;
    check(download.suggestedFilename().endsWith('-annotations.json'), 'the app did not download the annotation JSON export');
    const stream = await download.createReadStream();
    let serialized = '';
    for await (const chunk of stream) serialized += chunk.toString('utf8');
    const exported = JSON.parse(serialized);

    equal(exported.document.fileName, demo.fileName, 'the JSON export references a different document');
    equal(exported.task.mode, 'assist', 'the JSON export omitted the selected review mode');
    check(exported.task.plan && exported.task.plan.title, 'the JSON export omitted the visible task plan');
    equal(exported.reviewQueue.length, 1, 'the unresolved candidate should remain in the review queue');
    equal(exported.documentAnnotations.filter((record) => record.status === 'needs_review').length, 1, 'the pending review status was not exported');

    if (scenario.action === 'approve') {
      equal(exported.annotations.length, 1, 'approval should create one annotation');
      equal(exported.annotations[0].label, scenario.expectedLabel, 'approval changed the candidate label');
      equal(exported.annotations[0].reviewedByHuman, true, 'the approved annotation is not marked as human reviewed');
      equal(exported.annotations[0].source, scenario.expectedSource, 'approval lost its AI source');
      const record = exported.documentAnnotations.find((item) => item.id === exported.annotations[0].id);
      equal(record.status, scenario.expectedStatus, 'the canonical export should preserve approval without marking it as a correction');
      equal(exported.humanRejected.length, 0, 'approval should not create a rejected record');
    } else if (scenario.action === 'correct') {
      equal(exported.annotations.length, 1, 'correction should create one annotation');
      equal(exported.annotations[0].label, scenario.expectedLabel, 'the corrected label was not applied');
      equal(exported.annotations[0].reviewedByHuman, true, 'the corrected annotation is not marked as human reviewed');
      equal(exported.annotations[0].source, scenario.expectedSource, 'the corrected annotation should be marked as manual');
      const record = exported.documentAnnotations.find((item) => item.id === exported.annotations[0].id);
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

  const aiRequests = requestUrls.filter((url) => /\/api\/(?:ai|codex)\//i.test(url));
  equal(aiRequests.length, 0, `the browser attempted provider or AI endpoints: ${aiRequests.join(', ')}`);
  equal(externalRequests.length, 0, `the browser attempted non-local network requests: ${externalRequests.join(', ')}`);
  equal(consoleErrors.length, 0, `the browser reported console errors: ${consoleErrors.join(' | ')}`);
  return `approve, correct, and reject passed; exported JSON states verified; no provider calls or browser console errors`;
}
