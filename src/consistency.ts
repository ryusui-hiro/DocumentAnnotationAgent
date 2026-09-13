import type { Annotation } from './types';

export interface AnnotationConsistencyIssue {
  id: string;
  kind: 'same_excerpt' | 'similar_excerpt' | 'model_review';
  excerpt: string;
  labels: string[];
  occurrences: Array<{ annotationId: string; pageNumber: number; label: string; excerpt: string }>;
  validatorType?: 'label_conflict' | 'similar_excerpt' | 'unsupported_claim' | 'evidence_gap';
  validatorTitle?: string;
  validatorReason?: string;
  reviewPriority?: 'low' | 'medium' | 'high';
}

const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'if', 'in', 'into', 'is', 'it', 'may', 'must', 'of', 'on', 'or', 'the', 'this', 'that', 'to', 'under', 'with', 'within', 'without']);
const similarExcerptThreshold = 0.6;

function normalizeExcerpt(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function pairId(left: string, right: string) {
  return JSON.stringify(left < right ? [left, right] : [right, left]);
}

function excerptTokens(value: string) {
  const normalized = normalizeExcerpt(value);
  const tokens = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      if (word.length > 2 && !stopWords.has(word)) tokens.add(word);
      continue;
    }
    const characters = Array.from(word);
    if (characters.length === 1) tokens.add(word);
    for (let index = 0; index < characters.length - 1 && tokens.size < 128; index += 1) tokens.add(`${characters[index]}${characters[index + 1]}`);
  }
  return tokens;
}

export function findInconsistentRepeatedExcerpts(annotations: Pick<Annotation, 'id' | 'pageNumber' | 'label' | 'excerpt'>[]): AnnotationConsistencyIssue[] {
  const annotationById = new Map<string, typeof annotations[number]>();
  for (const annotation of annotations.slice(0, 500)) {
    if (annotation.id && annotation.excerpt?.trim() && !annotationById.has(annotation.id)) annotationById.set(annotation.id, annotation);
  }
  const uniqueAnnotations = [...annotationById.values()];
  const groups = new Map<string, Array<{ annotationId: string; pageNumber: number; label: string; excerpt: string }>>();
  for (const annotation of uniqueAnnotations) {
    const excerpt = annotation.excerpt?.trim() ?? '';
    const key = normalizeExcerpt(excerpt);
    if (key.length < 12) continue;
    const rows = groups.get(key) ?? [];
    rows.push({ annotationId: annotation.id, pageNumber: annotation.pageNumber, label: annotation.label.trim(), excerpt });
    groups.set(key, rows);
  }

  const exactIssues: AnnotationConsistencyIssue[] = [];
  const exactPairs = new Set<string>();
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const labels = [...new Set(rows.map((row) => normalizeExcerpt(row.label)).filter(Boolean))];
    const ids = [...new Set(rows.map((row) => row.annotationId))];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) exactPairs.add(pairId(ids[left]!, ids[right]!));
    }
    if (labels.length < 2) continue;
    const occurrences = rows
      .map(({ annotationId, pageNumber, label, excerpt }) => ({ annotationId, pageNumber, label, excerpt }))
      .sort((left, right) => left.pageNumber - right.pageNumber);
    exactIssues.push({
      id: `same:${key}`,
      kind: 'same_excerpt',
      excerpt: rows[0]?.excerpt ?? '',
      labels: [...new Set(occurrences.map((row) => row.label))],
      occurrences,
    });
  }

  const features = uniqueAnnotations.map((annotation) => ({
    annotation,
    normalized: normalizeExcerpt(annotation.excerpt ?? ''),
    normalizedLength: Array.from(normalizeExcerpt(annotation.excerpt ?? '')).length,
    labelKey: normalizeExcerpt(annotation.label),
    tokens: excerptTokens(annotation.excerpt ?? ''),
  }));
  const similarNeighbors = new Map<number, Set<number>>();
  for (let left = 0; left < features.length; left += 1) {
    const first = features[left]!;
    if (first.normalizedLength < 24 || first.tokens.size < 6) continue;
    for (let right = left + 1; right < features.length; right += 1) {
      const second = features[right]!;
      if (first.annotation.pageNumber === second.annotation.pageNumber || exactPairs.has(pairId(first.annotation.id, second.annotation.id))) continue;
      if (first.labelKey === second.labelKey) continue;
      if (second.normalizedLength < 24 || second.tokens.size < 6) continue;
      let shared = 0;
      for (const token of first.tokens) if (second.tokens.has(token)) shared += 1;
      const unionSize = first.tokens.size + second.tokens.size - shared;
      if (shared < 4 || !unionSize || shared / unionSize < similarExcerptThreshold) continue;
      const firstNeighbors = similarNeighbors.get(left) ?? new Set<number>();
      const secondNeighbors = similarNeighbors.get(right) ?? new Set<number>();
      firstNeighbors.add(right);
      secondNeighbors.add(left);
      similarNeighbors.set(left, firstNeighbors);
      similarNeighbors.set(right, secondNeighbors);
    }
  }

  const similarIssues: AnnotationConsistencyIssue[] = [];
  const visited = new Set<number>();
  for (const start of similarNeighbors.keys()) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    visited.add(start);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const neighbor of similarNeighbors.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    const occurrences = component
      .map((index) => features[index]!.annotation)
      .map((annotation) => ({ annotationId: annotation.id, pageNumber: annotation.pageNumber, label: annotation.label.trim(), excerpt: annotation.excerpt?.trim() ?? '' }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
    const labels = [...new Set(occurrences.map((item) => normalizeExcerpt(item.label)).filter(Boolean))];
    if (labels.length < 2) continue;
    const ids = occurrences.map((item) => item.annotationId).sort();
    similarIssues.push({
      id: `similar:${JSON.stringify(ids)}`,
      kind: 'similar_excerpt',
      excerpt: occurrences[0]?.excerpt ?? '',
      labels: [...new Set(occurrences.map((item) => item.label))],
      occurrences,
    });
  }

  return [...exactIssues, ...similarIssues].sort((left, right) => {
    const leftPage = Math.min(...left.occurrences.map((item) => item.pageNumber));
    const rightPage = Math.min(...right.occurrences.map((item) => item.pageNumber));
    return leftPage - rightPage || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });
}

export function restoreAnnotationConsistencyIssues(value: unknown): AnnotationConsistencyIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry): AnnotationConsistencyIssue[] => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    const kind = ['same_excerpt', 'similar_excerpt', 'model_review'].includes(String(raw.kind)) ? raw.kind as AnnotationConsistencyIssue['kind'] : undefined;
    if (!kind || typeof raw.id !== 'string' || !Array.isArray(raw.occurrences)) return [];
    const occurrences = raw.occurrences.slice(0, 10).flatMap((item): AnnotationConsistencyIssue['occurrences'] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const pageNumber = Number(row.pageNumber);
      if (typeof row.annotationId !== 'string' || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 120 || typeof row.label !== 'string') return [];
      return [{
        annotationId: row.annotationId.slice(0, 100),
        pageNumber,
        label: row.label.slice(0, 60),
        excerpt: typeof row.excerpt === 'string' ? row.excerpt.slice(0, 1000) : '',
      }];
    });
    if (!occurrences.length) return [];
    const validatorType = ['label_conflict', 'similar_excerpt', 'unsupported_claim', 'evidence_gap'].includes(String(raw.validatorType))
      ? raw.validatorType as NonNullable<AnnotationConsistencyIssue['validatorType']>
      : undefined;
    const reviewPriority = ['low', 'medium', 'high'].includes(String(raw.reviewPriority))
      ? raw.reviewPriority as AnnotationConsistencyIssue['reviewPriority']
      : undefined;
    return [{
      id: raw.id.slice(0, 500),
      kind,
      excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 1000) : '',
      labels: Array.isArray(raw.labels) ? raw.labels.filter((label): label is string => typeof label === 'string').slice(0, 10).map((label) => label.slice(0, 60)) : [...new Set(occurrences.map((item) => item.label))],
      occurrences,
      ...(validatorType ? { validatorType } : {}),
      ...(typeof raw.validatorTitle === 'string' ? { validatorTitle: raw.validatorTitle.slice(0, 160) } : {}),
      ...(typeof raw.validatorReason === 'string' ? { validatorReason: raw.validatorReason.slice(0, 600) } : {}),
      ...(reviewPriority ? { reviewPriority } : {}),
    }];
  });
}
