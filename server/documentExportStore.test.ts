import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocumentExportStore } from './documentExportStore';
import { createPrivateRecordStore } from './privateRecordStore';

test('stores download-ready exports encrypted and returns only bounded metadata to the Agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-studio-export-'));
  try {
    const store = createDocumentExportStore(createPrivateRecordStore(directory));
    const buffer = Buffer.from('Private export payload.');
    const descriptor = await store.put('doc-123', 'contracts/source.pdf', {
      format: 'annotations-json', fileName: 'source-annotations.json', contentType: 'application/json', buffer,
      annotationsExported: 3, skipped: [{ annotationId: 'private-id', label: 'PRIVATE', reason: 'not exported' }],
    });
    assert.equal(descriptor.fileName, 'source-annotations.json');
    assert.equal(descriptor.annotationsExported, 3);
    assert.equal(descriptor.skippedCount, 1);
    assert.equal('buffer' in descriptor, false);
    assert.equal('contentType' in descriptor, false);
    const storedText = await readFile(join(directory, 'document-exports', `${descriptor.id}.json`), 'utf8');
    assert.equal(storedText.includes(buffer.toString()), false, 'export bytes are encrypted at rest');
    assert.deepEqual((await store.get(descriptor.id))?.buffer, buffer);
    assert.equal(await store.get('not-an-export-id'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
