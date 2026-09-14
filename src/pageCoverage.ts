import type { AgentHumanDecisionRecord, AgentPageCoverage, AnnotationCandidate, ConvertedPage } from './types';

type CoverageCandidate = Pick<AnnotationCandidate, 'id' | 'pageNumber'>;
type CoverageToolEvent = { toolName?: unknown; pageNumber?: unknown; textBlockCount?: unknown; warningCount?: unknown };

export function selectUninspectedPages(targetPages: number[], inspectedPages: Iterable<number>): number[] {
  const inspected = new Set([...inspectedPages].filter((page) => Number.isInteger(page) && page > 0));
  return targetPages.filter((page) => !inspected.has(page));
}

export function inferFullDocumentContinuation(args: {
  fullDocument?: boolean;
  remainingPages: number[];
  visitedPages?: number[];
  pageCoverageTargets?: number[];
  pageCount: number;
}): boolean {
  if (typeof args.fullDocument === 'boolean') return args.fullDocument;
  if (args.pageCoverageTargets?.length === args.pageCount && args.pageCount > 0) return true;
  const knownPages = new Set([...args.visitedPages ?? [], ...args.remainingPages]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= args.pageCount));
  return knownPages.size >= args.pageCount || args.remainingPages.length > 1;
}

export function acknowledgePageCoverage(existing: AgentPageCoverage[], pageNumber: number): AgentPageCoverage[] {
  return existing.map((item) => item.pageNumber === pageNumber && (item.status === 'image_only' || (item.status === 'checked' && item.warningCount > 0))
    ? {
      ...item,
      ...(item.status === 'image_only' ? { humanReviewed: true } : {}),
      ...(item.warningCount > 0 ? { warningAcknowledged: true } : {}),
    }
    : item);
}

export function countResolvedReviewCandidatesOnPage(decisions: AgentHumanDecisionRecord[], pageNumber: number): number {
  return new Set(decisions.filter((decision) => decision.pageNumber === pageNumber).map((decision) => decision.sourceCandidateId)).size;
}

export function mergeResumedPageCoverage(args: {
  existing: AgentPageCoverage[];
  toolEvents: unknown;
  returned: CoverageCandidate[];
  newlyPending: CoverageCandidate[];
  existingFindingIds: Iterable<string>;
  pageWarnings: ConvertedPage[];
  resolvedCandidatePage?: number;
  resolvedCandidateCount?: number;
}): AgentPageCoverage[] {
  const coverage = new Map(args.existing.map((item) => [item.pageNumber, item]));
  if (Number.isInteger(args.resolvedCandidatePage)) {
    const resolved = coverage.get(args.resolvedCandidatePage!);
    if (resolved) coverage.set(args.resolvedCandidatePage!, { ...resolved, reviewCount: Math.max(0, resolved.reviewCount - Math.max(1, args.resolvedCandidateCount ?? 1)) });
  }

  const existingIds = new Set(args.existingFindingIds);
  const newFindingIdsByPage = new Map<number, Set<string>>();
  const newReviewIdsByPage = new Map<number, Set<string>>();
  const addNewCandidate = (byPage: Map<number, Set<string>>, candidate: CoverageCandidate) => {
    if (existingIds.has(candidate.id)) return;
    const ids = byPage.get(candidate.pageNumber) ?? new Set<string>();
    ids.add(candidate.id);
    byPage.set(candidate.pageNumber, ids);
  };
  args.returned.forEach((candidate) => addNewCandidate(newFindingIdsByPage, candidate));
  args.newlyPending.forEach((candidate) => addNewCandidate(newReviewIdsByPage, candidate));

  const resumedPages = new Map<number, { opened: boolean; inspected: boolean; textBlockCount?: number; warningCount: number }>();
  for (const rawEvent of Array.isArray(args.toolEvents) ? args.toolEvents : []) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const event = rawEvent as CoverageToolEvent;
    if (event.toolName !== 'inspect_page' && event.toolName !== 'navigate_page') continue;
    if (!Number.isInteger(event.pageNumber)) continue;
    const pageNumber = Number(event.pageNumber);
    if (pageNumber < 1 || pageNumber > 120) continue;
    const previous = resumedPages.get(pageNumber);
    const inspected = event.toolName === 'inspect_page';
    const textBlockCount = inspected && Number.isFinite(event.textBlockCount) ? Number(event.textBlockCount) : previous?.textBlockCount;
    resumedPages.set(pageNumber, {
      opened: true,
      inspected: Boolean(previous?.inspected || inspected),
      ...(textBlockCount !== undefined ? { textBlockCount } : {}),
      warningCount: Math.max(previous?.warningCount ?? 0, Number.isFinite(event.warningCount) ? Number(event.warningCount) : 0),
    });
  }

  for (const [pageNumber, resumed] of resumedPages) {
    const previous = coverage.get(pageNumber);
    const textBlockCount = resumed.textBlockCount ?? previous?.textBlockCount;
    const documentWarningCount = args.pageWarnings.find((page) => page.pageNumber === pageNumber)?.warningCount ?? 0;
    const warningCount = Math.max(previous?.warningCount ?? 0, documentWarningCount, resumed.warningCount);
    const status: AgentPageCoverage['status'] = resumed.inspected
      ? textBlockCount === undefined ? previous?.status ?? 'opened' : textBlockCount === 0 ? 'image_only' : 'checked'
      : previous?.status === 'checked' ? previous.status : 'opened';
    const findingCount = (previous?.findingCount ?? 0) + (newFindingIdsByPage.get(pageNumber)?.size ?? 0);
    const reviewCount = (previous?.reviewCount ?? 0) + (newReviewIdsByPage.get(pageNumber)?.size ?? 0);
    coverage.set(pageNumber, {
      pageNumber, status, findingCount, reviewCount, warningCount,
      ...(textBlockCount !== undefined ? { textBlockCount } : {}),
      ...(status === 'opened' ? { detail: 'The Agent navigated to this page but did not return an explicit page inspection.' }
        : status === 'image_only' ? { detail: 'No positioned text was extracted; the page image was supplied for visual review.' }
          : warningCount > 0 ? { detail: `The converter reported ${warningCount} warning${warningCount === 1 ? '' : 's'} for this page.` } : {}),
    });
  }

  return [...coverage.values()].sort((left, right) => left.pageNumber - right.pageNumber);
}
