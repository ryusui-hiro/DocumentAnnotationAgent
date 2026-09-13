import type { AgentActivityEvent, AgentMode, AgentPageCoverage, AgentRunHistory, AnnotationCandidate, AnnotationReviewPriority, NormalizedTextBox, PageCoverageStatus, TextAnchor } from './types';
import { parseTaskPlan } from './taskPlan';

const historyPrefix = 'annotation-studio:run-history:';
export const maxSavedAgentRuns = 20;
const maxEventsPerRun = 48;
const maxEventDetailLength = 1200;
const maxObservationFindingsPerRun = 100;
const maxObservationFieldLength = 1000;

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function historyKey(fileName: string, sourceHash?: string) {
  const base = `${historyPrefix}${fileName}`;
  return sourceHash ? `${base}:source:${sourceHash}` : base;
}

const modes: AgentMode[] = ['observe', 'suggest', 'assist', 'autopilot'];
const runStatuses = ['running', 'waiting', 'complete', 'error', 'interrupted'] as const;
const activityPhases = ['Planning', 'Navigating', 'Reading', 'Searching', 'Annotating', 'Reviewing', 'Asking', 'Continuing', 'Exporting'] as const;
const activityStatuses = ['active', 'complete', 'waiting', 'error'] as const;
const pageCoverageStatuses: PageCoverageStatus[] = ['checked', 'image_only', 'opened', 'failed', 'demo_only'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEvent(value: unknown): AgentActivityEvent | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.detail !== 'string' ||
    !activityPhases.includes(value.phase as (typeof activityPhases)[number]) ||
    !activityStatuses.includes(value.status as (typeof activityStatuses)[number]) || !Number.isFinite(value.createdAt)) return null;
  const event: AgentActivityEvent = {
    id: value.id.slice(0, 100),
    phase: value.phase as AgentActivityEvent['phase'],
    detail: value.detail.slice(0, maxEventDetailLength),
    status: value.status as AgentActivityEvent['status'],
    createdAt: Number(value.createdAt),
  };
  if (Number.isFinite(value.pageNumber)) event.pageNumber = Number(value.pageNumber);
  return event;
}

function readObservationFinding(value: unknown): AnnotationCandidate | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || !value.label.trim() || typeof value.note !== 'string' ||
    !Number.isInteger(value.pageNumber) || Number(value.pageNumber) < 1 || Number(value.pageNumber) > 120 ||
    !['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) return null;
  const x = value.x as number;
  const y = value.y as number;
  const width = value.width as number;
  const height = value.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return null;
  const priority = ['low', 'medium', 'high'].includes(String(value.reviewPriority)) ? value.reviewPriority as AnnotationReviewPriority : undefined;
  const color = typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '#278779';
  const fragments = Array.isArray(value.fragments) ? value.fragments.slice(0, 32).flatMap((item): NormalizedTextBox[] => {
    if (!isRecord(item) || !['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number' && Number.isFinite(item[key]))) return [];
    const rect = { x: item.x as number, y: item.y as number, width: item.width as number, height: item.height as number };
    return rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1.001 && rect.y + rect.height <= 1.001 ? [{ ...rect, width: Math.min(rect.width, 1 - rect.x), height: Math.min(rect.height, 1 - rect.y) }] : [];
  }) : [];
  const rawAnchor = isRecord(value.textAnchor) ? value.textAnchor : null;
  const rawQuote = rawAnchor && isRecord(rawAnchor.quote) ? rawAnchor.quote : null;
  const rawPosition = rawAnchor && isRecord(rawAnchor.position) ? rawAnchor.position : null;
  const textAnchor: TextAnchor | undefined = rawQuote && rawPosition
    && typeof rawQuote.exact === 'string' && rawQuote.exact.trim()
    && typeof rawQuote.prefix === 'string' && typeof rawQuote.suffix === 'string'
    && Number.isInteger(rawPosition.start) && Number.isInteger(rawPosition.end)
    && Number(rawPosition.start) >= 0 && Number(rawPosition.end) >= Number(rawPosition.start)
    && rawPosition.unit === 'normalized-page-text'
    ? {
      quote: { exact: rawQuote.exact.slice(0, maxObservationFieldLength), prefix: rawQuote.prefix.slice(-100), suffix: rawQuote.suffix.slice(0, 100) },
      position: { start: Number(rawPosition.start), end: Number(rawPosition.end), unit: 'normalized-page-text' },
    }
    : undefined;
  return {
    id: value.id.slice(0, 100),
    pageNumber: Number(value.pageNumber),
    x, y, width, height,
    label: value.label.trim().slice(0, 120),
    note: value.note.slice(0, 500),
    color,
    source: 'ai',
    ...(priority ? { reviewPriority: priority } : {}),
    ...(typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? { confidence: Math.max(0, Math.min(1, value.confidence)) } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 500) } : {}),
    ...(typeof value.requiresReview === 'boolean' ? { requiresReview: value.requiresReview } : {}),
    ...(typeof value.excerpt === 'string' ? { excerpt: value.excerpt.slice(0, maxObservationFieldLength) } : {}),
    ...(fragments.length ? { fragments } : {}),
    ...(textAnchor ? { textAnchor } : {}),
  };
}

function readPageCoverage(value: unknown): AgentPageCoverage[] {
  if (!Array.isArray(value)) return [];
  const byPage = new Map<number, AgentPageCoverage>();
  for (const item of value.slice(0, 120)) {
    if (!isRecord(item) || !Number.isInteger(item.pageNumber) || Number(item.pageNumber) < 1 || Number(item.pageNumber) > 120 ||
      !pageCoverageStatuses.includes(item.status as PageCoverageStatus)) continue;
    const coverage: AgentPageCoverage = {
      pageNumber: Number(item.pageNumber),
      status: item.status as PageCoverageStatus,
      findingCount: Number.isFinite(item.findingCount) ? Math.max(0, Math.min(500, Math.floor(Number(item.findingCount)))) : 0,
      reviewCount: Number.isFinite(item.reviewCount) ? Math.max(0, Math.min(500, Math.floor(Number(item.reviewCount)))) : 0,
      warningCount: Number.isFinite(item.warningCount) ? Math.max(0, Math.min(100, Math.floor(Number(item.warningCount)))) : 0,
      ...(Number.isFinite(item.textBlockCount) ? { textBlockCount: Math.max(0, Math.min(2000, Math.floor(Number(item.textBlockCount)))) } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail.slice(0, 500) } : {}),
    };
    byPage.set(coverage.pageNumber, coverage);
  }
  return [...byPage.values()].sort((left, right) => left.pageNumber - right.pageNumber);
}

function readEntry(value: unknown, fileName: string): AgentRunHistory | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.fileName !== fileName ||
    !Number.isFinite(value.startedAt) || typeof value.instruction !== 'string' ||
    !modes.includes(value.mode as AgentMode) || !runStatuses.includes(value.status as AgentRunHistory['status']) ||
    !Number.isFinite(value.totalPages) || !Number.isFinite(value.completedPages) || !Array.isArray(value.events)) return null;
  const wasRunning = value.status === 'running';
  const events = value.events.map(readEvent).filter((event): event is AgentActivityEvent => event !== null).slice(-maxEventsPerRun)
    .map((event) => wasRunning && event.status === 'active' ? { ...event, status: 'error' as const } : event);
  const taskPlan = parseTaskPlan(value.taskPlan);
  const observationFindings = Array.isArray(value.observationFindings)
    ? value.observationFindings.map(readObservationFinding).filter((finding): finding is AnnotationCandidate => finding !== null).slice(0, maxObservationFindingsPerRun)
    : undefined;
  const observationFindingOverflow = Number.isFinite(value.observationFindingOverflow)
    ? Math.max(0, Math.min(100_000, Math.floor(Number(value.observationFindingOverflow))))
    : 0;
  const pageCoverageTargets = Array.isArray(value.pageCoverageTargets)
    ? [...new Set(value.pageCoverageTargets.map(Number).filter((page) => Number.isInteger(page) && page >= 1 && page <= 120))].slice(0, 120)
    : undefined;
  return {
    id: value.id.slice(0, 100),
    fileName,
    ...(typeof value.sourceHash === 'string' && /^[\da-f]{64}$/i.test(value.sourceHash) ? { sourceHash: value.sourceHash.toLowerCase() } : {}),
    startedAt: Number(value.startedAt),
    ...(Number.isFinite(value.endedAt) ? { endedAt: Number(value.endedAt) } : wasRunning ? { endedAt: Date.now() } : {}),
    instruction: value.instruction.slice(0, 2000),
    mode: value.mode as AgentMode,
    status: wasRunning ? 'interrupted' : value.status as AgentRunHistory['status'],
    totalPages: Math.max(0, Math.min(10000, Number(value.totalPages))),
    completedPages: Math.max(0, Math.min(Number(value.totalPages), Number(value.completedPages))),
    ...(typeof value.summary === 'string' ? { summary: value.summary.slice(0, 2000) } : wasRunning ? { summary: 'ページの再読み込み前に実行が中断されました。' } : {}),
    ...(taskPlan ? { taskPlan } : {}),
    ...(observationFindings ? { observationFindings } : {}),
    ...(observationFindingOverflow > 0 ? { observationFindingOverflow } : {}),
    ...(pageCoverageTargets ? { pageCoverageTargets } : {}),
    ...(Array.isArray(value.pageCoverage) ? { pageCoverage: readPageCoverage(value.pageCoverage) } : {}),
    events,
  };
}

export function readAgentRunHistory(storage: HistoryStorage, fileName: string, sourceHash?: string): AgentRunHistory[] {
  try {
    const value = (sourceHash ? storage.getItem(historyKey(fileName, sourceHash)) : null)
      ?? storage.getItem(historyKey(fileName));
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => readEntry(entry, fileName))
      .filter((entry): entry is AgentRunHistory => entry !== null)
      .filter((entry) => !sourceHash || entry.sourceHash === sourceHash)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, maxSavedAgentRuns);
  } catch {
    return [];
  }
}

export function upsertAgentRunHistory(current: AgentRunHistory[], entry: AgentRunHistory): AgentRunHistory[] {
  const next = [entry, ...current.filter((item) => item.id !== entry.id)]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, maxSavedAgentRuns);
  return next.map((item) => ({
    ...item,
    instruction: item.instruction.slice(0, 2000),
    summary: item.summary?.slice(0, 2000),
    events: item.events.slice(-maxEventsPerRun).map((event) => ({ ...event, detail: event.detail.slice(0, maxEventDetailLength) })),
    ...(item.observationFindings ? {
      observationFindings: item.observationFindings.map(readObservationFinding).filter((finding): finding is AnnotationCandidate => finding !== null).slice(0, maxObservationFindingsPerRun),
      ...(Number.isFinite(item.observationFindingOverflow) && item.observationFindingOverflow! > 0 ? { observationFindingOverflow: Math.min(100_000, Math.floor(item.observationFindingOverflow!)) } : {}),
    } : {}),
    ...(item.pageCoverageTargets ? { pageCoverageTargets: [...new Set(item.pageCoverageTargets.filter((page) => Number.isInteger(page) && page >= 1 && page <= 120))].slice(0, 120) } : {}),
    ...(item.pageCoverage ? { pageCoverage: readPageCoverage(item.pageCoverage) } : {}),
  }));
}

export function writeAgentRunHistory(storage: HistoryStorage, fileName: string, history: AgentRunHistory[], sourceHash?: string) {
  try {
    const eligible = sourceHash ? history.filter((entry) => entry.sourceHash === sourceHash) : history;
    storage.setItem(historyKey(fileName, sourceHash), JSON.stringify(eligible.slice(0, maxSavedAgentRuns)));
  } catch {
    // Keep the in-memory history when device storage is unavailable or full.
  }
}
