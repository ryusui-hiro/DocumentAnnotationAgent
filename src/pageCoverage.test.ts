import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentPageCoverage } from './types';
import { acknowledgePageCoverage, countResolvedReviewCandidatesOnPage, inferFullDocumentContinuation, mergeResumedPageCoverage, selectUninspectedPages } from './pageCoverage';
import { resolveHumanReviewStatus } from './runHistory';

const checkedPage = (pageNumber: number, reviewCount = 0, findingCount = 0): AgentPageCoverage => ({
  pageNumber, status: 'checked', findingCount, reviewCount, warningCount: 0, textBlockCount: 12,
});

test('full-document continuation schedules opened pages until they receive an inspection', () => {
  assert.deepEqual(selectUninspectedPages([1, 2, 3, 4], [1, 3, 4]), [2]);
  assert.deepEqual(selectUninspectedPages([1, 2, 3], [3, 1, 2]), []);
});

test('visual and converter-warning gaps resolve only after the reviewer records an acknowledgement', () => {
  const coverage: AgentPageCoverage[] = [
    { pageNumber: 1, status: 'image_only', findingCount: 0, reviewCount: 0, warningCount: 0, textBlockCount: 0 },
    { pageNumber: 2, status: 'checked', findingCount: 0, reviewCount: 0, warningCount: 1, textBlockCount: 7 },
  ];
  assert.equal(resolveHumanReviewStatus(false, [1, 2], coverage).status, 'waiting');
  const acknowledged = acknowledgePageCoverage(coverage, 1);
  assert.equal(resolveHumanReviewStatus(false, [1, 2], acknowledged).status, 'waiting');
  const allAcknowledged = acknowledgePageCoverage(acknowledged, 2);
  assert.equal(resolveHumanReviewStatus(false, [1, 2], allAcknowledged).status, 'complete');
  assert.equal(allAcknowledged[0]?.humanReviewed, true);
  assert.equal(allAcknowledged[1]?.warningAcknowledged, true);
});

test('legacy one-page continuations recover full-document scope from saved coverage', () => {
  assert.equal(inferFullDocumentContinuation({
    remainingPages: [4], visitedPages: [1, 2, 3], pageCoverageTargets: [1, 2, 3, 4], pageCount: 4,
  }), true);
  assert.equal(inferFullDocumentContinuation({ remainingPages: [2], visitedPages: [1, 3, 4], pageCount: 4 }), true);
  assert.equal(inferFullDocumentContinuation({ remainingPages: [2], visitedPages: [1], pageCount: 4 }), false);
  assert.equal(inferFullDocumentContinuation({ fullDocument: false, remainingPages: [2], pageCoverageTargets: [1, 2, 3, 4], pageCount: 4 }), false);
});

test('resumed duplicate page inspections count each new finding and review item once', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(1), checkedPage(2)],
    toolEvents: [
      { toolName: 'inspect_page', pageNumber: 3, textBlockCount: 8, warningCount: 0 },
      { toolName: 'inspect_page', pageNumber: 3, textBlockCount: 8, warningCount: 0 },
    ],
    returned: [{ id: 'appendix', pageNumber: 3 }],
    newlyPending: [{ id: 'appendix', pageNumber: 3 }],
    existingFindingIds: [],
    pageWarnings: [],
  });

  assert.deepEqual(coverage.find((item) => item.pageNumber === 3), {
    pageNumber: 3, status: 'checked', findingCount: 1, reviewCount: 1, warningCount: 0, textBlockCount: 8,
  });
});

test('a resolved candidate and a new review on the same page leave the exact review count', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(2, 2, 2)],
    toolEvents: [{ toolName: 'inspect_page', pageNumber: 2, textBlockCount: 7 }],
    returned: [{ id: 'old-review', pageNumber: 2 }, { id: 'new-review', pageNumber: 2 }],
    newlyPending: [{ id: 'new-review', pageNumber: 2 }],
    existingFindingIds: ['old-review'],
    pageWarnings: [],
    resolvedCandidatePage: 2,
  });

  assert.deepEqual(coverage[0], { pageNumber: 2, status: 'checked', findingCount: 3, reviewCount: 2, warningCount: 0, textBlockCount: 7 });
});

test('resolving multiple same-page reviews decrements the coverage count for each candidate', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(4, 3, 3)], toolEvents: [], returned: [], newlyPending: [], existingFindingIds: [], pageWarnings: [],
    resolvedCandidatePage: 4, resolvedCandidateCount: 3,
  });
  assert.equal(coverage[0]?.reviewCount, 0);
});

test('review count uses unique resolved candidate ids per page', () => {
  assert.equal(countResolvedReviewCandidatesOnPage([
    { id: 'd1', action: 'approve', scope: 'item', sourceCandidateId: 'a', pageNumber: 4, text: 'Approved', createdAt: 1 },
    { id: 'd2', action: 'correct', scope: 'item', sourceCandidateId: 'a', pageNumber: 4, text: 'Corrected', createdAt: 2 },
    { id: 'd3', action: 'reject', scope: 'item', sourceCandidateId: 'b', pageNumber: 4, text: 'Rejected', createdAt: 3 },
    { id: 'd4', action: 'approve', scope: 'item', sourceCandidateId: 'c', pageNumber: 2, text: 'Other page', createdAt: 4 },
  ], 4), 2);
});

test('a non-SDK candidate decision resolves its saved review count without a new tool event', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(1, 1, 1)], toolEvents: [], returned: [], newlyPending: [], existingFindingIds: [], pageWarnings: [], resolvedCandidatePage: 1,
  });
  assert.equal(coverage[0]?.reviewCount, 0);
  assert.deepEqual(resolveHumanReviewStatus(false, [1], coverage), { status: 'complete', coverageStillNeedsReview: false });
});

test('navigation without inspection is recorded as opened and keeps the run waiting', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(1)],
    toolEvents: [{ toolName: 'navigate_page', pageNumber: 2, textBlockCount: 10 }],
    returned: [], newlyPending: [], existingFindingIds: [], pageWarnings: [],
  });
  assert.equal(coverage.find((item) => item.pageNumber === 2)?.status, 'opened');
  assert.deepEqual(resolveHumanReviewStatus(false, [1, 2], coverage), { status: 'waiting', coverageStillNeedsReview: true });
});

test('a navigation-only revisit does not downgrade a page already checked', () => {
  const coverage = mergeResumedPageCoverage({
    existing: [checkedPage(2)], toolEvents: [{ toolName: 'navigate_page', pageNumber: 2 }],
    returned: [], newlyPending: [], existingFindingIds: [], pageWarnings: [],
  });
  assert.equal(coverage[0]?.status, 'checked');
});
