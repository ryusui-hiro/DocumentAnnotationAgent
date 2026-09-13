import type { WorkspaceDocumentEntry, WorkspaceFileStatus, WorkspaceProject } from './types';

export const workspaceProjectStorageKey = 'annotation-studio:workspace-project';
export const maxWorkspaceDocuments = 200;
const supportedExtensions = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff']);
const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'target', 'dist', 'build', '.next', '.venv']);
const fileStatuses: WorkspaceFileStatus[] = ['ready', 'running', 'complete', 'review', 'error'];

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function isSupportedWorkspaceFile(path: string) {
  const fileName = path.split(/[\\/]/).at(-1) ?? '';
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  return Boolean(extension && supportedExtensions.has(extension));
}

export function shouldIgnoreWorkspaceDirectory(name: string) {
  return ignoredDirectories.has(name.toLowerCase()) || name.startsWith('._');
}

function readDocument(value: unknown): WorkspaceDocumentEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.relativePath !== 'string' || !isSupportedWorkspaceFile(record.relativePath)) return null;
  const status = fileStatuses.includes(record.status as WorkspaceFileStatus) ? record.status as WorkspaceFileStatus : 'ready';
  return {
    id: record.id.slice(0, 500),
    relativePath: record.relativePath.replaceAll('\\', '/').slice(0, 1000),
    selected: record.selected !== false,
    status: status === 'running' ? 'ready' : status,
    ...(typeof record.error === 'string' ? { error: record.error.slice(0, 500) } : {}),
    ...(Number.isFinite(record.size) ? { size: Math.max(0, Number(record.size)) } : {}),
    ...(Number.isFinite(record.lastModified) ? { lastModified: Math.max(0, Number(record.lastModified)) } : {}),
    ...(typeof record.sourceHash === 'string' && /^[\da-f]{64}$/i.test(record.sourceHash) ? { sourceHash: record.sourceHash.toLowerCase() } : {}),
    ...(typeof record.nativePath === 'string' ? { nativePath: record.nativePath.slice(0, 4000) } : {}),
  };
}

export function loadWorkspaceProject(storage: WorkspaceStorage): WorkspaceProject | null {
  try {
    const stored = storage.getItem(workspaceProjectStorageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || !['desktop', 'browser'].includes(String(record.source)) || !Array.isArray(record.documents)) return null;
    const documents = record.documents.map(readDocument).filter((entry): entry is WorkspaceDocumentEntry => entry !== null).slice(0, maxWorkspaceDocuments);
    return {
      id: record.id.slice(0, 500),
      name: record.name.slice(0, 500),
      source: record.source as WorkspaceProject['source'],
      connected: false,
      ...(typeof record.rootPath === 'string' ? { rootPath: record.rootPath.slice(0, 4000) } : {}),
      documents,
    };
  } catch {
    return null;
  }
}

export function saveWorkspaceProject(storage: WorkspaceStorage, project: WorkspaceProject) {
  try {
    const documents = project.documents.slice(0, maxWorkspaceDocuments).map(({ id, relativePath, selected, status, error, size, lastModified, sourceHash, nativePath }) => ({
      id, relativePath, selected, status, ...(error ? { error } : {}), ...(size !== undefined ? { size } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}), ...(sourceHash ? { sourceHash } : {}), ...(nativePath ? { nativePath } : {}),
    }));
    storage.setItem(workspaceProjectStorageKey, JSON.stringify({
      id: project.id,
      name: project.name,
      source: project.source,
      ...(project.rootPath ? { rootPath: project.rootPath } : {}),
      documents,
    }));
  } catch {
    // Keep the current project in memory if browser storage is unavailable or full.
  }
}
