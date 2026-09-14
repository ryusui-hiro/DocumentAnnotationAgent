import { createHash } from 'node:crypto';

export type InspectionCheckpoint = {
  sourceHash: string;
  totalPages: number;
  pages: number[];
  updatedAt: number;
};

export type InspectionScopeInput = {
  documentId: string;
  sourceHash: string;
  totalPages: number;
  instruction: string;
  taskPlan: string;
  guidelines: string;
  mode: string;
};

const maximumCheckpointScopes = 12;

export function inspectionScopeKey(input: InspectionScopeInput) {
  const stableInput = {
    documentId: input.documentId,
    sourceHash: input.sourceHash,
    totalPages: input.totalPages,
    instruction: input.instruction.trim(),
    taskPlan: input.taskPlan.trim(),
    guidelines: input.guidelines.trim(),
    mode: input.mode,
  };
  return createHash('sha256').update(JSON.stringify(stableInput)).digest('hex');
}

export function sanitizeInspectionCheckpoints(
  input: unknown,
  sourceHash: string,
  totalPages: number,
  now = Date.now(),
): Record<string, InspectionCheckpoint> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries: Array<[string, InspectionCheckpoint]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[\da-f]{64}$/i.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Partial<InspectionCheckpoint>;
    if (record.sourceHash !== sourceHash || record.totalPages !== totalPages
      || !Number.isFinite(record.updatedAt) || Number(record.updatedAt) < now - 30 * 60 * 1000
      || Number(record.updatedAt) > now + 60_000 || !Array.isArray(record.pages) || record.pages.length > totalPages) continue;
    const pages = record.pages.filter((page): page is number => Number.isSafeInteger(page) && page >= 1 && page <= totalPages);
    if (pages.length !== record.pages.length || new Set(pages).size !== pages.length) continue;
    entries.push([key, { sourceHash, totalPages, pages: pages.sort((left, right) => left - right), updatedAt: Number(record.updatedAt) }]);
  }
  entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  return Object.fromEntries(entries.slice(0, maximumCheckpointScopes));
}

export function mergeInspectionCheckpoint(
  checkpoints: Record<string, InspectionCheckpoint> | undefined,
  key: string,
  sourceHash: string,
  totalPages: number,
  pages: readonly number[],
  now = Date.now(),
) {
  const safeCurrent = sanitizeInspectionCheckpoints(checkpoints, sourceHash, totalPages, now);
  const prior = safeCurrent[key];
  const accepted = pages.filter((page) => Number.isSafeInteger(page) && page >= 1 && page <= totalPages);
  const mergedPages = [...new Set([...(prior?.pages ?? []), ...accepted])].sort((left, right) => left - right);
  safeCurrent[key] = { sourceHash, totalPages, pages: mergedPages, updatedAt: now };
  return Object.fromEntries(Object.entries(safeCurrent)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, maximumCheckpointScopes));
}
