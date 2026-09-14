import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundledApiSharedSourceNames, bundledDemoAssetNames, copyApiSources, copyBundledDemoAssets } from './prepare-tauri-runtime.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('Tauri API runtime includes every built-in demo file', async () => {
  assert.ok(bundledDemoAssetNames.includes('demos/customer-churn-risk-demo.xlsx'), 'the synthetic churn workbook must be listed as a bundled desktop asset');
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-runtime-demo-assets-'));
  try {
    await copyBundledDemoAssets(runtimeDirectory);
    for (const fileName of bundledDemoAssetNames) {
      const source = await readFile(join(projectRoot, 'public', fileName));
      const bundled = await readFile(join(runtimeDirectory, 'public', fileName));
      assert.deepEqual(bundled, source, `${fileName} must be copied into the desktop API runtime unchanged`);
    }
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test('Tauri API runtime includes the shared validator snapshot implementation', async () => {
  assert.ok(bundledApiSharedSourceNames.includes('validatorSnapshotSignature.ts'));
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-runtime-shared-api-'));
  try {
    await copyApiSources(runtimeDirectory);
    const source = await readFile(join(projectRoot, 'src', 'validatorSnapshotSignature.ts'));
    const bundled = await readFile(join(runtimeDirectory, 'src', 'validatorSnapshotSignature.ts'));
    assert.deepEqual(bundled, source, 'documentAgent imports this runtime module during bundled startup');
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
