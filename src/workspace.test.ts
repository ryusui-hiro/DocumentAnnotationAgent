import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSupportedWorkspaceFile, loadWorkspaceProject, saveWorkspaceProject, shouldIgnoreWorkspaceDirectory, workspaceProjectStorageKey } from './workspace';
import type { WorkspaceProject } from './types';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('filters supported documents and generated folders for workspace projects', () => {
  assert.equal(isSupportedWorkspaceFile('specs/contract.PDF'), true);
  assert.equal(isSupportedWorkspaceFile('img/scan.tiff'), true);
  assert.equal(isSupportedWorkspaceFile('src/app.ts'), false);
  assert.equal(shouldIgnoreWorkspaceDirectory('.git'), true);
  assert.equal(shouldIgnoreWorkspaceDirectory('node_modules'), true);
  assert.equal(shouldIgnoreWorkspaceDirectory('customer-docs'), false);
});

test('stores project metadata and requires the user to reconnect the folder after reload', () => {
  const storage = new MemoryStorage();
  const project: WorkspaceProject = {
    id: '/work/contracts', name: 'contracts', source: 'desktop', rootPath: '/work/contracts', connected: true,
    documents: [{ id: 'a.pdf', relativePath: 'contracts/a.pdf', selected: true, status: 'running', nativePath: '/work/contracts/a.pdf' }],
  };
  saveWorkspaceProject(storage, project);
  const restored = loadWorkspaceProject(storage);
  assert.equal(storage.getItem(workspaceProjectStorageKey) !== null, true);
  assert.equal(restored?.connected, false);
  assert.equal(restored?.documents[0]?.status, 'ready');
  assert.equal(restored?.documents[0]?.nativePath, '/work/contracts/a.pdf');
});
