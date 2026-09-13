import type { PreparedDocumentExport } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const formats = new Set(['native-annotated', 'annotations-json', 'annotations-csv']);

export function restorePreparedDocumentExports(value: unknown, sourceDocumentName?: string): PreparedDocumentExport[] {
  if (!Array.isArray(value)) return [];
  const restored = value.filter(isRecord).flatMap((item): PreparedDocumentExport[] => {
    if (typeof item.id !== 'string' || !/^\d{13}_(?:\d+_)?[0-9a-f-]{36}$/i.test(item.id) ||
      typeof item.documentId !== 'string' || item.documentId.length > 100 ||
      typeof item.sourceDocumentName !== 'string' || item.sourceDocumentName.length > 1000 ||
      typeof item.fileName !== 'string' || item.fileName.length > 180 ||
      !formats.has(String(item.format)) || !Number.isFinite(item.annotationsExported) ||
      !Number.isFinite(item.skippedCount) || !Number.isFinite(item.expiresAt) || Number(item.expiresAt) <= Date.now()) return [];
    if (sourceDocumentName && item.sourceDocumentName !== sourceDocumentName) return [];
    return [{
      id: item.id,
      documentId: item.documentId,
      sourceDocumentName: item.sourceDocumentName,
      fileName: item.fileName,
      format: item.format as PreparedDocumentExport['format'],
      annotationsExported: Math.max(0, Math.floor(Number(item.annotationsExported))),
      skippedCount: Math.max(0, Math.floor(Number(item.skippedCount))),
      expiresAt: Number(item.expiresAt),
    }];
  });
  return restored.slice(-32);
}

export function mergePreparedDocumentExports(current: PreparedDocumentExport[], added: PreparedDocumentExport[]) {
  const byId = new Map<string, PreparedDocumentExport>();
  for (const artifact of [...current, ...added]) {
    if (artifact.expiresAt > Date.now()) byId.set(artifact.id, artifact);
  }
  return [...byId.values()].slice(-32);
}
