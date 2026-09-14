export type ValidatorSnapshotAnnotation = {
  id: string;
  pageNumber: number;
  label: string;
  excerpt: string;
  explanation: string;
  reviewPriority: 'low' | 'medium' | 'high';
  status: 'auto' | 'approved' | 'corrected' | 'needs_review';
};

export type ValidatorSnapshotSignatureInput = {
  documentId: string;
  sourceHash: string;
  instruction: string;
  taskPlan: string;
  guidelines: string;
  correction: string;
  humanDecisions: string;
  annotations: ValidatorSnapshotAnnotation[];
};

export function buildValidatorSnapshotPayload(input: ValidatorSnapshotSignatureInput): ValidatorSnapshotSignatureInput {
  const annotationsById = new Map(input.annotations.map((annotation) => [annotation.id, {
    id: annotation.id,
    pageNumber: annotation.pageNumber,
    label: annotation.label,
    excerpt: annotation.excerpt,
    explanation: annotation.explanation,
    reviewPriority: annotation.reviewPriority,
    status: annotation.status,
  }]));
  return {
    documentId: input.documentId,
    sourceHash: input.sourceHash,
    instruction: input.instruction,
    taskPlan: input.taskPlan,
    guidelines: input.guidelines,
    correction: input.correction,
    humanDecisions: input.humanDecisions,
    annotations: [...annotationsById.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  };
}

export function canonicalValidatorSnapshotJson(input: ValidatorSnapshotSignatureInput) {
  return JSON.stringify(buildValidatorSnapshotPayload(input));
}

export async function validatorSnapshotSignature(input: ValidatorSnapshotSignatureInput) {
  const bytes = new TextEncoder().encode(canonicalValidatorSnapshotJson(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
