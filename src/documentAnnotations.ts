import type { Annotation, AnnotationCandidate, AnnotationReviewPriority, DocumentAnnotationRecord, NormalizedTextBox, SpreadsheetCellChange, TextAnchor } from './types';
import { annotationReviewStatus } from './annotationStatus';

function visualTarget(annotation: Annotation, fileType: string): DocumentAnnotationRecord['target'] {
  const boundingBox = { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height };
  const fragments = annotation.fragments?.slice(0, 32);
  const textAnchor = annotation.textAnchor;
  return fileType.toLowerCase() === 'pptx'
    ? { kind: 'slide', slide: annotation.pageNumber, boundingBox, ...(fragments?.length ? { fragments } : {}), ...(textAnchor ? { textAnchor } : {}) }
    : { kind: 'page', page: annotation.pageNumber, boundingBox, ...(fragments?.length ? { fragments } : {}), ...(textAnchor ? { textAnchor } : {}) };
}

function visualStatus(annotation: Annotation): DocumentAnnotationRecord['status'] {
  return annotationReviewStatus(annotation);
}

function visualRecord(documentId: string, fileType: string, sourceHash: string | undefined, annotation: Annotation & Pick<Partial<AnnotationCandidate>, 'approvalRunId' | 'approvalId'>, status = visualStatus(annotation)): DocumentAnnotationRecord {
  return {
    id: annotation.id,
    documentId,
    ...(sourceHash ? { sourceHash } : {}),
    target: visualTarget(annotation, fileType),
    label: annotation.label,
    evidence: annotation.excerpt ?? '',
    explanation: [annotation.reason, annotation.note].filter(Boolean).join('\n'),
    reviewPriority: annotation.reviewPriority ?? (status === 'needs_review' ? 'high' : annotation.source === 'manual' ? 'low' : 'medium'),
    status,
    ...(annotation.confidence !== undefined ? { confidence: annotation.confidence } : {}),
    note: annotation.note,
    reason: annotation.reason ?? '',
    excerpt: annotation.excerpt ?? '',
    color: annotation.color,
    source: annotation.source,
    requiresReview: Boolean(annotation.requiresReview),
    reviewedByHuman: Boolean(annotation.reviewedByHuman),
    ...(annotation.approvalRunId ? { approvalRunId: annotation.approvalRunId } : {}),
    ...(annotation.approvalId ? { approvalId: annotation.approvalId } : {}),
  };
}

export function normalizeDocumentAnnotationRecords(args: {
  documentId: string;
  sourceHash?: string;
  fileType: string;
  annotations: Annotation[];
  candidates: AnnotationCandidate[];
  rejectedCandidates: AnnotationCandidate[];
  spreadsheetChanges: SpreadsheetCellChange[];
}): DocumentAnnotationRecord[] {
  const records = [
    ...args.annotations.map((annotation) => visualRecord(args.documentId, args.fileType, args.sourceHash, annotation)),
    ...args.candidates.map((candidate) => visualRecord(args.documentId, args.fileType, args.sourceHash, candidate, 'needs_review')),
    ...args.rejectedCandidates.map((candidate) => visualRecord(args.documentId, args.fileType, args.sourceHash, candidate, 'rejected')),
    ...args.spreadsheetChanges.map((change): DocumentAnnotationRecord => {
      const status = change.rejected ? 'rejected' : change.requiresReview ? 'needs_review' : change.reviewOutcome ?? 'auto';
      return {
        id: change.id,
        documentId: args.documentId,
        ...(args.sourceHash ? { sourceHash: args.sourceHash } : {}),
        target: { kind: 'sheet', sheet: change.sheetName, cellRange: change.range },
        label: change.operation === 'create_column' ? `Create column: ${String(change.values[0]?.[0] ?? '')}` : 'Workbook cell update',
        evidence: JSON.stringify(change.values),
        explanation: change.reason,
        reviewPriority: change.reviewPriority ?? (status === 'needs_review' ? 'high' : 'medium'),
        status,
        ...(change.confidence !== undefined ? { confidence: change.confidence } : {}),
        note: change.reason,
        reason: change.reason,
        operation: change.operation,
        values: change.values,
        requiresReview: change.requiresReview,
        approved: Boolean(change.approved),
        rejected: Boolean(change.rejected),
        ...(change.approvalRunId ? { approvalRunId: change.approvalRunId } : {}),
        ...(change.approvalId ? { approvalId: change.approvalId } : {}),
      };
    }),
  ];
  const byId = new Map<string, DocumentAnnotationRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function readNormalizedBox(value: unknown): NormalizedTextBox | null {
  if (!isRecord(value) || !['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) return null;
  const x = value.x as number;
  const y = value.y as number;
  const width = value.width as number;
  const height = value.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return null;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

function readTextAnchor(value: unknown): TextAnchor | undefined {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.position)) return undefined;
  const { exact, prefix, suffix } = value.quote;
  const { start, end, unit } = value.position;
  if (typeof exact !== 'string' || !exact.trim() || typeof prefix !== 'string' || typeof suffix !== 'string' ||
    !Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) < Number(start) || unit !== 'normalized-page-text') return undefined;
  return {
    quote: { exact: exact.slice(0, 1000), prefix: prefix.slice(-100), suffix: suffix.slice(0, 100) },
    position: { start: Number(start), end: Number(end), unit },
  };
}

const reviewPriorities = new Set(['low', 'medium', 'high']);
const annotationStatuses = new Set(['auto', 'needs_review', 'approved', 'corrected', 'rejected']);

export function spreadsheetChangeStatusLabel(change: SpreadsheetCellChange): string {
  if (change.rejected) return '却下';
  if (change.requiresReview) return '承認待ち';
  if (change.reviewOutcome === 'approved') return '承認済み';
  if (change.reviewOutcome === 'corrected') return '修正済み';
  return change.approved ? '適用済み' : '未適用';
}

/** Restores UI-facing arrays from the canonical document annotation records. */
export function restoreDocumentAnnotationRecords(value: unknown) {
  const annotations: Annotation[] = [];
  const candidates: AnnotationCandidate[] = [];
  const rejectedCandidates: AnnotationCandidate[] = [];
  const spreadsheetChanges: SpreadsheetCellChange[] = [];
  if (!Array.isArray(value)) return { annotations, candidates, rejectedCandidates, spreadsheetChanges };

  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.label !== 'string' || !isRecord(raw.target)) continue;
    const target = raw.target;
    const hasCanonicalStatus = annotationStatuses.has(String(raw.status));
    const status = hasCanonicalStatus ? raw.status as DocumentAnnotationRecord['status'] : 'auto';
    const reviewPriority = reviewPriorities.has(String(raw.reviewPriority)) ? raw.reviewPriority as AnnotationReviewPriority : status === 'needs_review' ? 'high' : 'medium';
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : undefined;

    if (target.kind === 'page' || target.kind === 'slide') {
      if (!isRecord(target.boundingBox)) continue;
      const rawPageNumber = Number(target.kind === 'page' ? target.page : target.slide);
      if (!Number.isFinite(rawPageNumber) || rawPageNumber < 1 || rawPageNumber > 120) continue;
      const pageNumber = Math.floor(rawPageNumber);
      const fragments = Array.isArray(target.fragments)
        ? target.fragments.slice(0, 32).map(readNormalizedBox).filter((box): box is NormalizedTextBox => box !== null)
        : [];
      const textAnchor = readTextAnchor(target.textAnchor);
      const x = boundedNumber(target.boundingBox.x, 0, 0, 0.98);
      const y = boundedNumber(target.boundingBox.y, 0, 0, 0.98);
      const width = Math.min(1 - x, boundedNumber(target.boundingBox.width, 0.02, 0.015, 1));
      const height = Math.min(1 - y, boundedNumber(target.boundingBox.height, 0.02, 0.01, 1));
      const source = raw.source === 'manual' ? 'manual' : 'ai';
      const requiresReview = hasCanonicalStatus ? status === 'needs_review' : Boolean(raw.requiresReview);
      const annotation: AnnotationCandidate = {
        id: raw.id.slice(0, 100), pageNumber, x, y, width, height,
        label: raw.label.slice(0, 60),
        note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : typeof raw.explanation === 'string' ? raw.explanation.slice(0, 500) : '',
        color: typeof raw.color === 'string' ? raw.color.slice(0, 30) : source === 'manual' ? '#178b87' : '#278779',
        source,
        ...(confidence !== undefined ? { confidence } : {}),
        reviewPriority,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : typeof raw.explanation === 'string' ? raw.explanation.slice(0, 500) : '',
        requiresReview,
        excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 1000) : typeof raw.evidence === 'string' ? raw.evidence.slice(0, 1000) : '',
        ...(fragments.length ? { fragments } : {}),
        ...(textAnchor ? { textAnchor } : {}),
        reviewedByHuman: hasCanonicalStatus ? status === 'approved' || status === 'corrected' : Boolean(raw.reviewedByHuman),
        ...(status === 'approved' || status === 'corrected' ? { reviewOutcome: status } : {}),
        ...(typeof raw.approvalRunId === 'string' ? { approvalRunId: raw.approvalRunId.slice(0, 100) } : {}),
        ...(typeof raw.approvalId === 'string' ? { approvalId: raw.approvalId.slice(0, 200) } : {}),
      };
      if (status === 'rejected') rejectedCandidates.push(annotation);
      else if (status === 'needs_review' || requiresReview) candidates.push(annotation);
      else annotations.push(annotation);
      continue;
    }

    if (target.kind === 'sheet' && ['write_cell', 'write_range', 'create_column'].includes(String(raw.operation)) && typeof target.sheet === 'string') {
      const values = Array.isArray(raw.values) ? raw.values.slice(0, 100).map((row) => Array.isArray(row) ? row.slice(0, 50) as SpreadsheetCellChange['values'][number] : []) : [];
      spreadsheetChanges.push({
        id: raw.id.slice(0, 100), operation: raw.operation as SpreadsheetCellChange['operation'],
        sheetName: target.sheet.slice(0, 120), range: typeof target.cellRange === 'string' ? target.cellRange.slice(0, 30) : '',
        values, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : typeof raw.explanation === 'string' ? raw.explanation.slice(0, 500) : '',
        ...(confidence !== undefined ? { confidence } : {}), reviewPriority,
        requiresReview: hasCanonicalStatus ? status === 'needs_review' : Boolean(raw.requiresReview),
        ...((hasCanonicalStatus ? ['auto', 'approved', 'corrected'].includes(status) : Boolean(raw.approved)) ? { approved: true } : {}),
        ...((hasCanonicalStatus ? status === 'rejected' : Boolean(raw.rejected)) ? { rejected: true } : {}),
        ...(status === 'approved' || status === 'corrected' ? { reviewOutcome: status } : {}),
        ...(typeof raw.approvalRunId === 'string' ? { approvalRunId: raw.approvalRunId.slice(0, 100) } : {}),
        ...(typeof raw.approvalId === 'string' ? { approvalId: raw.approvalId.slice(0, 200) } : {}),
      });
    }
  }
  return { annotations, candidates, rejectedCandidates, spreadsheetChanges };
}

export function resolveCandidateReview(
  current: ReturnType<typeof restoreDocumentAnnotationRecords>,
  candidateId: string,
  outcome:
    | { type: 'approve' | 'correct'; annotation: Annotation }
    | { type: 'reject'; candidate: AnnotationCandidate },
) {
  const withoutCandidate = current.candidates.filter((candidate) => candidate.id !== candidateId);
  if (outcome.type === 'reject') {
    return {
      ...current,
      candidates: withoutCandidate,
      annotations: current.annotations.filter((annotation) => annotation.id !== candidateId),
      rejectedCandidates: [...current.rejectedCandidates.filter((candidate) => candidate.id !== candidateId), outcome.candidate],
    };
  }
  return {
    ...current,
    candidates: withoutCandidate,
    rejectedCandidates: current.rejectedCandidates.filter((candidate) => candidate.id !== candidateId),
    annotations: [...current.annotations.filter((annotation) => annotation.id !== candidateId), outcome.annotation],
  };
}

/** Reads a saved per-document workspace and rebinds its records to the current server session. */
export function readStoredDocumentAnnotationRecords(raw: string | null, documentId: string, fileType: string, sourceHash?: string): DocumentAnnotationRecord[] {
  if (!raw) return [];
  try {
    const stored: unknown = JSON.parse(raw);
    let restored: ReturnType<typeof restoreDocumentAnnotationRecords>;
    if (Array.isArray(stored)) {
      restored = { annotations: stored.filter(isRecord) as unknown as Annotation[], candidates: [], rejectedCandidates: [], spreadsheetChanges: [] };
    } else if (isRecord(stored)) {
      if (Array.isArray(stored.documentAnnotations)) {
        restored = restoreDocumentAnnotationRecords(stored.documentAnnotations);
      } else {
        restored = {
          annotations: Array.isArray(stored.annotations) ? stored.annotations.filter(isRecord) as unknown as Annotation[] : [],
          candidates: Array.isArray(stored.candidates) ? stored.candidates.filter(isRecord) as unknown as AnnotationCandidate[] : [],
          rejectedCandidates: Array.isArray(stored.rejectedCandidates) ? stored.rejectedCandidates.filter(isRecord) as unknown as AnnotationCandidate[] : [],
          spreadsheetChanges: Array.isArray(stored.spreadsheetChanges) ? stored.spreadsheetChanges.filter(isRecord) as unknown as SpreadsheetCellChange[] : [],
        };
      }
    } else {
      return [];
    }
    const rawHashes = Array.isArray(stored)
      ? stored.filter(isRecord).map((record) => record.sourceHash).filter((hash): hash is string => typeof hash === 'string')
      : isRecord(stored) && Array.isArray(stored.documentAnnotations)
        ? stored.documentAnnotations.filter(isRecord).map((record) => record.sourceHash).filter((hash): hash is string => typeof hash === 'string')
        : [];
    if (sourceHash && rawHashes.some((hash) => hash !== sourceHash)) return [];
    const normalized = normalizeDocumentAnnotationRecords({ documentId, sourceHash, fileType, ...restored });
    const checked = restoreDocumentAnnotationRecords(normalized);
    return normalizeDocumentAnnotationRecords({ documentId, sourceHash, fileType, ...checked });
  } catch {
    return [];
  }
}
