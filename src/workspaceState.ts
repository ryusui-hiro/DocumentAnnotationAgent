const prefix = 'annotation-studio:annotations:';

export type WorkspaceStateStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type WorkspaceStateRead = {
  status: 'missing' | 'match' | 'changed' | 'legacy';
  raw: string | null;
  previousSourceHash?: string;
};

export function workspaceStateKey(fileName: string, sourceHash?: string) {
  const base = `${prefix}${fileName}`;
  return sourceHash ? `${base}:source:${sourceHash}` : base;
}

function parseRecord(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classify(raw: string | null, sourceHash?: string): WorkspaceStateRead {
  if (!raw) return { status: 'missing', raw: null };
  const record = parseRecord(raw);
  const storedHash = typeof record?.sourceHash === 'string' ? record.sourceHash : undefined;
  if (sourceHash && storedHash && storedHash !== sourceHash) {
    return { status: 'changed', raw: null, previousSourceHash: storedHash };
  }
  if (sourceHash && !storedHash) return { status: 'legacy', raw };
  return { status: 'match', raw, ...(storedHash ? { previousSourceHash: storedHash } : {}) };
}

export function readWorkspaceState(storage: WorkspaceStateStorage, fileName: string, sourceHash?: string): WorkspaceStateRead {
  try {
    if (sourceHash) {
      const exactVersion = storage.getItem(workspaceStateKey(fileName, sourceHash));
      if (exactVersion) return classify(exactVersion, sourceHash);
    }

    const base = storage.getItem(workspaceStateKey(fileName));
    if (!base) return { status: 'missing', raw: null };
    const envelope = parseRecord(base);
    if (envelope?.version === 4 && typeof envelope.workspaceKey === 'string' && typeof envelope.sourceHash === 'string') {
      if (sourceHash && envelope.sourceHash !== sourceHash) {
        return { status: 'changed', raw: null, previousSourceHash: envelope.sourceHash };
      }
      return classify(storage.getItem(envelope.workspaceKey), sourceHash);
    }
    return classify(base, sourceHash);
  } catch {
    return { status: 'missing', raw: null };
  }
}

export function writeWorkspaceState(storage: WorkspaceStateStorage, fileName: string, sourceHash: string | undefined, value: unknown) {
  const serialized = JSON.stringify(value);
  const baseKey = workspaceStateKey(fileName);
  if (!sourceHash) {
    storage.setItem(baseKey, serialized);
    return;
  }
  const versionKey = workspaceStateKey(fileName, sourceHash);
  storage.setItem(versionKey, serialized);
  storage.setItem(baseKey, JSON.stringify({ version: 4, sourceHash, workspaceKey: versionKey }));
}
