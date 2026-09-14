import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDocumentAnnotationRecords, resolveCandidateReview, restoreDocumentAnnotationRecords } from './documentAnnotations';
import { terminationContractDemoAnnotations, terminationContractDemoCandidate, terminationContractDemoFileName, terminationContractDemoGuidelines, terminationContractDemoPrompt } from './terminationContractDemo';

test('termination contract sample is explicitly fictional and keeps just the undefined clause in review', () => {
  assert.equal(terminationContractDemoFileName, 'fictional-termination-contract.pdf');
  assert.match(terminationContractDemoPrompt, /every termination clause/i);
  assert.match(terminationContractDemoPrompt, /ask me when the wording is uncertain/i);
  assert.match(terminationContractDemoGuidelines, /not legal advice or model output/i);
  assert.equal(terminationContractDemoAnnotations.length, 5);
  assert.ok(terminationContractDemoAnnotations.every((annotation) => annotation.source === 'demo' && !annotation.requiresReview));
  assert.equal(new Set(terminationContractDemoAnnotations.map((annotation) => annotation.id)).size, terminationContractDemoAnnotations.length);
  assert.equal(terminationContractDemoCandidate.source, 'demo');
  assert.equal(terminationContractDemoCandidate.requiresReview, true);
  assert.equal(terminationContractDemoCandidate.pageNumber, 2);
  assert.match(terminationContractDemoCandidate.excerpt ?? '', /reasonable business circumstances/i);
  assert.match(terminationContractDemoCandidate.reason ?? '', /human/i);
});

test('scripted demo provenance survives canonical storage and a human approval', () => {
  const sourceHash = 'a'.repeat(64);
  const initial = normalizeDocumentAnnotationRecords({
    documentId: 'fictional-contract-session', sourceHash, fileType: 'PDF',
    annotations: terminationContractDemoAnnotations,
    candidates: [terminationContractDemoCandidate], rejectedCandidates: [], spreadsheetChanges: [],
  });
  const restored = restoreDocumentAnnotationRecords(initial);
  assert.ok(restored.annotations.every((annotation) => annotation.source === 'demo'));
  assert.equal(restored.candidates[0]?.source, 'demo');

  const reviewed = resolveCandidateReview(restored, terminationContractDemoCandidate.id, {
    type: 'approve',
    annotation: { ...terminationContractDemoCandidate, source: 'demo', requiresReview: false, reviewedByHuman: true, reviewOutcome: 'approved' },
  });
  const saved = normalizeDocumentAnnotationRecords({
    documentId: 'fictional-contract-session', sourceHash, fileType: 'PDF', ...reviewed,
  });
  const reloaded = restoreDocumentAnnotationRecords(saved);
  const approved = reloaded.annotations.find((annotation) => annotation.id === terminationContractDemoCandidate.id);
  assert.equal(reloaded.candidates.length, 0);
  assert.equal(approved?.source, 'demo');
  assert.equal(approved?.reviewOutcome, 'approved');
});
