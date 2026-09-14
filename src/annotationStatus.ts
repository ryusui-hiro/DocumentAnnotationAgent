import type { Annotation, DocumentAnnotationStatus } from './types';

/** Derives the canonical review state for visual annotations across UI, agent, and export paths. */
export function annotationReviewStatus(annotation: Pick<Annotation, 'reviewOutcome' | 'reviewedByHuman' | 'source' | 'requiresReview'>): DocumentAnnotationStatus {
  if (annotation.reviewOutcome) return annotation.reviewOutcome;
  if (annotation.reviewedByHuman) return annotation.source === 'manual' ? 'corrected' : 'approved';
  if (annotation.requiresReview) return 'needs_review';
  if (annotation.source === 'manual') return 'approved';
  return 'auto';
}
