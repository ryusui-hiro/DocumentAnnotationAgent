import type { Annotation, DocumentAnnotationStatus } from './types';

/** Derives the canonical review state for visual annotations across UI, agent, and export paths. */
export function annotationReviewStatus(annotation: Pick<Annotation, 'reviewOutcome' | 'reviewedByHuman' | 'source' | 'requiresReview' | 'reviewPriority'>): DocumentAnnotationStatus {
  if (annotation.reviewOutcome) return annotation.reviewOutcome;
  if (annotation.reviewedByHuman) return annotation.source === 'ai' ? 'approved' : 'corrected';
  if (annotation.requiresReview || annotation.reviewPriority === 'high') return 'needs_review';
  if (annotation.source === 'manual') return 'approved';
  return 'auto';
}
