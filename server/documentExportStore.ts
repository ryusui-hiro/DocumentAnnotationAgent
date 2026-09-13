import { randomUUID } from 'node:crypto';
import type { PreparedDocumentExport } from '../src/types';
import type { DocumentExportResult } from './documentAdapter';
import { privateRecordStore } from './privateRecordStore';

const namespace = 'document-exports';
const artifactTtlMs = 30 * 60 * 1000;
const maxArtifacts = 32;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxTotalArtifactBytes = 256 * 1024 * 1024;

type StoredDocumentExport = PreparedDocumentExport & {
  createdAt: number;
  contentType: string;
  bufferBase64: string;
};

function metadataFromId(id: string) {
  const match = id.match(/^(\d{13})_(?:(\d+)_)?([0-9a-f-]{36})$/i);
  if (!match) return undefined;
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return undefined;
  const bytes = match[2] === undefined ? undefined : Number(match[2]);
  return { createdAt, bytes: bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined };
}

export function createDocumentExportStore(store: typeof privateRecordStore = privateRecordStore) {
  const prune = async (requiredBytes = 0) => {
    const now = Date.now();
    const active: Array<{ id: string; createdAt: number; bytes: number }> = [];
    for (const id of await store.list(namespace)) {
      const metadata = metadataFromId(id);
      if (!metadata || metadata.createdAt + artifactTtlMs <= now) await store.delete(namespace, id);
      else active.push({ id, createdAt: metadata.createdAt, bytes: metadata.bytes ?? maxArtifactBytes });
    }
    active.sort((left, right) => left.createdAt - right.createdAt);
    let totalBytes = active.reduce((total, item) => total + item.bytes, 0);
    while (active.length >= maxArtifacts || totalBytes + requiredBytes > maxTotalArtifactBytes) {
      const expired = active.shift();
      if (expired) {
        totalBytes -= expired.bytes;
        await store.delete(namespace, expired.id);
      }
    }
  };

  return {
    async put(documentId: string, sourceDocumentName: string, result: DocumentExportResult): Promise<PreparedDocumentExport> {
      if (result.buffer.byteLength > maxArtifactBytes) throw Object.assign(new Error('Agent-prepared export exceeds the 64 MiB download limit. Use the direct export action instead.'), { status: 413 });
      const createdAt = Date.now();
      await prune(result.buffer.byteLength);
      const descriptor: PreparedDocumentExport = {
        id: `${createdAt}_${result.buffer.byteLength}_${randomUUID()}`,
        documentId,
        sourceDocumentName: sourceDocumentName.slice(0, 1000),
        fileName: result.fileName,
        format: result.format,
        annotationsExported: result.annotationsExported,
        skippedCount: result.skipped.length,
        expiresAt: createdAt + artifactTtlMs,
      };
      const record: StoredDocumentExport = {
        ...descriptor,
        createdAt,
        contentType: result.contentType,
        bufferBase64: result.buffer.toString('base64'),
      };
      await store.put(namespace, descriptor.id, record);
      return descriptor;
    },

    async get(id: string): Promise<{ descriptor: PreparedDocumentExport; contentType: string; buffer: Buffer } | null> {
      if (!metadataFromId(id)) return null;
      const record = await store.get<StoredDocumentExport>(namespace, id);
      if (!record || record.id !== id || record.expiresAt <= Date.now()) {
        if (record) await store.delete(namespace, id);
        return null;
      }
      return {
        descriptor: {
          id: record.id,
          documentId: record.documentId,
          sourceDocumentName: record.sourceDocumentName,
          fileName: record.fileName,
          format: record.format,
          annotationsExported: record.annotationsExported,
          skippedCount: record.skippedCount,
          expiresAt: record.expiresAt,
        },
        contentType: record.contentType,
        buffer: Buffer.from(record.bufferBase64, 'base64'),
      };
    },

    prune,
  };
}

export const documentExportStore = createDocumentExportStore();
