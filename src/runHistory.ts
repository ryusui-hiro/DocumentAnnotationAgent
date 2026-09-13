import type { AgentActivityEvent, AgentMode, AgentRunHistory, AnnotationCandidate, AnnotationReviewPriority } from './types';
import { parseTaskPlan } from './taskPlan';

const historyPrefix = 'annotation-studio:run-history:';
export const maxSavedAgentRuns = 20;
const maxEventsPerRun = 48;
const maxEventDetailLength = 1200;
const maxObservationFindingsPerRun = 100;
const maxObservationFieldLength = 1000;

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

const modes: AgentMode[] = ['observe', 'suggest', 'assist', 'autopilot'];
const runStatuses = ['running', 'waiting', 'complete', 'error', 'interrupted'] as const;
const activityPhases = ['Planning', 'Navigating', 'Reading', 'Searching', 'Annotating', 'Reviewing', 'Asking', 'Continuing', 'Exporting'] as const;
const activityStatuses = ['active', 'complete', 'waiting', 'error'] as const;

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
  };
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
  return {
    id: value.id.slice(0, 100),
    fileName,
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
    events,
  };
}

export function readAgentRunHistory(storage: HistoryStorage, fileName: string): AgentRunHistory[] {
  try {
    const value = storage.getItem(`${historyPrefix}${fileName}`);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => readEntry(entry, fileName))
      .filter((entry): entry is AgentRunHistory => entry !== null)
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
  }));
}

export function writeAgentRunHistory(storage: HistoryStorage, fileName: string, history: AgentRunHistory[]) {
  try {
    storage.setItem(`${historyPrefix}${fileName}`, JSON.stringify(history.slice(0, maxSavedAgentRuns)));
  } catch {
    // Keep the in-memory history when device storage is unavailable or full.
  }
}
