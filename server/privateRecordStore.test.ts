import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateRecordStore } from './privateRecordStore';

test('stores compressed private records encrypted with user-only file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-private-'));
  try {
    const store = createPrivateRecordStore(directory);
    const record = { prompt: 'Sensitive contract language', pages: [1, 2, 3] };
    await store.put('pending-agent-runs', 'run-123', record);
    const filePath = join(directory, 'pending-agent-runs', 'run-123.json');
    const content = await readFile(filePath, 'utf8');
    const keyInfo = await stat(join(directory, 'record-key'));
    const directoryInfo = await stat(directory);
    assert.equal(content.includes(record.prompt), false);
    assert.equal(keyInfo.mode & 0o777, 0o600);
    assert.equal(directoryInfo.mode & 0o777, 0o700);
    assert.deepEqual(await store.get('pending-agent-runs', 'run-123'), record);
    assert.deepEqual(await store.list('pending-agent-runs'), ['run-123']);
    await store.delete('pending-agent-runs', 'run-123');
    assert.equal(await store.get('pending-agent-runs', 'run-123'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects path separators in private record namespaces and ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-private-'));
  try {
    const store = createPrivateRecordStore(directory);
    await assert.rejects(store.put('../outside', 'run-123', { value: true }), /unsupported characters/);
    await assert.rejects(store.get('namespace', '../../outside'), /unsupported characters/);
    await assert.rejects(store.delete('namespace', 'nested/run-123'), /unsupported characters/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
