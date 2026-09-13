import type { Annotation, AnnotationCandidate, AnnotationReviewPriority, DocumentAnnotationRecord, SpreadsheetCellChange } from './types';

function visualTarget(annotation: Annotation, fileType: string): DocumentAnnotationRecord['target'] {
  const boundingBox = { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height };
  return fileType.toLowerCase() === 'pptx'
    ? { kind: 'slide', slide: annotation.pageNumber, boundingBox }
    : { kind: 'page', page: annotation.pageNumber, boundingBox };
}

function visualStatus(annotation: Annotation): DocumentAnnotationRecord['status'] {
  if (annotation.reviewedByHuman) return 'corrected';
  if (annotation.requiresReview || annotation.reviewPriority === 'high') return 'needs_review';
  if (annotation.source === 'manual') return 'approved';
  return 'auto';
}

function visualRecord(documentId: string, fileType: string, annotation: Annotation & Pick<Partial<AnnotationCandidate>, 'approvalRunId' | 'approvalId'>, status = visualStatus(annotation)): DocumentAnnotationRecord {
  return {
    id: annotation.id,
    documentId,
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
  fileType: string;
  annotations: Annotation[];
  candidates: AnnotationCandidate[];
  rejectedCandidates: AnnotationCandidate[];
  spreadsheetChanges: SpreadsheetCellChange[];
}): DocumentAnnotationRecord[] {
  const records = [
    ...args.annotations.map((annotation) => visualRecord(args.documentId, args.fileType, annotation)),
    ...args.candidates.map((candidate) => visualRecord(args.documentId, args.fileType, candidate, 'needs_review')),
    ...args.rejectedCandidates.map((candidate) => visualRecord(args.documentId, args.fileType, candidate, 'rejected')),
    ...args.spreadsheetChanges.map((change): DocumentAnnotationRecord => {
      const status = change.rejected ? 'rejected' : change.approved ? 'approved' : change.requiresReview ? 'needs_review' : 'auto';
      return {
        id: change.id,
        documentId: args.documentId,
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

const reviewPriorities = new Set(['low', 'medium', 'high']);
const annotationStatuses = new Set(['auto', 'needs_review', 'approved', 'corrected', 'rejected']);

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
    const status = annotationStatuses.has(String(raw.status)) ? raw.status as DocumentAnnotationRecord['status'] : 'auto';
    const reviewPriority = reviewPriorities.has(String(raw.reviewPriority)) ? raw.reviewPriority as AnnotationReviewPriority : status === 'needs_review' ? 'high' : 'medium';
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : undefined;

    if (target.kind === 'page' || target.kind === 'slide') {
      if (!isRecord(target.boundingBox)) continue;
      const rawPageNumber = Number(target.kind === 'page' ? target.page : target.slide);
      if (!Number.isFinite(rawPageNumber) || rawPageNumber < 1 || rawPageNumber > 120) continue;
      const pageNumber = Math.floor(rawPageNumber);
      const x = boundedNumber(target.boundingBox.x, 0, 0, 0.98);
      const y = boundedNumber(target.boundingBox.y, 0, 0, 0.98);
      const width = Math.min(1 - x, boundedNumber(target.boundingBox.width, 0.02, 0.015, 1));
      const height = Math.min(1 - y, boundedNumber(target.boundingBox.height, 0.02, 0.01, 1));
      const source = raw.source === 'manual' ? 'manual' : 'ai';
      const requiresReview = Boolean(raw.requiresReview) || status === 'needs_review';
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
        reviewedByHuman: Boolean(raw.reviewedByHuman) || status === 'corrected',
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
        requiresReview: Boolean(raw.requiresReview) || status === 'needs_review',
        ...(Boolean(raw.approved) || status === 'approved' || status === 'auto' ? { approved: true } : {}),
        ...(Boolean(raw.rejected) || status === 'rejected' ? { rejected: true } : {}),
        ...(typeof raw.approvalRunId === 'string' ? { approvalRunId: raw.approvalRunId.slice(0, 100) } : {}),
        ...(typeof raw.approvalId === 'string' ? { approvalId: raw.approvalId.slice(0, 200) } : {}),
      });
    }
  }
  return { annotations, candidates, rejectedCandidates, spreadsheetChanges };
}

/** Reads a saved per-document workspace and rebinds its records to the current server session. */
export function readStoredDocumentAnnotationRecords(raw: string | null, documentId: string, fileType: string): DocumentAnnotationRecord[] {
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
    const normalized = normalizeDocumentAnnotationRecords({ documentId, fileType, ...restored });
    const checked = restoreDocumentAnnotationRecords(normalized);
    return normalizeDocumentAnnotationRecords({ documentId, fileType, ...checked });
  } catch {
    return [];
  }
}
