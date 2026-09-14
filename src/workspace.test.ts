import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateDesktopWorkspace, isSupportedWorkspaceFile, loadWorkspaceProject, readNativeWorkspaceDocument, saveWorkspaceProject, shouldIgnoreWorkspaceDirectory, workspaceProjectStorageKey } from './workspace';
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
    documents: [{ id: 'a.pdf', relativePath: 'contracts/a.pdf', selected: true, status: 'running', sourceHash: 'a'.repeat(64), nativePath: '/work/contracts/a.pdf' }],
  };
  saveWorkspaceProject(storage, project);
  const restored = loadWorkspaceProject(storage);
  assert.equal(storage.getItem(workspaceProjectStorageKey) !== null, true);
  assert.equal(restored?.connected, false);
  assert.equal(restored?.documents[0]?.status, 'ready');
  assert.equal(restored?.documents[0]?.nativePath, '/work/contracts/a.pdf');
  assert.equal(restored?.documents[0]?.sourceHash, 'a'.repeat(64));
});

test('enumerates nested native workspace files, skips ignored folders and symlinks, and reads the selected source bytes', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-workspace-test-'));
  try {
    const root = join(temporaryDirectory, 'project');
    const nested = join(root, 'nested');
    const deep = join(nested, 'deep');
    await mkdir(deep, { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(nested, 'guide.pdf'), 'PDF source bytes from a nested project folder.');
    await writeFile(join(deep, 'photo.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, '.git', 'ignored.pdf'), 'Ignore generated metadata.');
    await writeFile(join(root, 'node_modules', 'ignored.docx'), 'Ignore dependencies.');
    await writeFile(join(root, 'notes.md'), 'Unsupported file.');
    const outsidePath = join(temporaryDirectory, 'outside.pdf');
    await writeFile(outsidePath, 'Do not follow links outside the project.');
    await symlink(outsidePath, join(root, 'linked.pdf'));

    const visitedDirectories: string[] = [];
    const readDir = async (directory: string) => {
      visitedDirectories.push(directory);
      return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
    };
    const documents = await enumerateDesktopWorkspace(root, readDir);
    assert.deepEqual(documents.map((entry) => entry.relativePath), ['nested/deep/photo.png', 'nested/guide.pdf']);
    assert.equal(visitedDirectories.some((directory) => directory.includes(`${join(root, '.git')}`)), false);
    assert.equal(visitedDirectories.some((directory) => directory.includes(`${join(root, 'node_modules')}`)), false);

    const guide = documents.find((entry) => entry.relativePath === 'nested/guide.pdf');
    assert.ok(guide?.nativePath);
    const source = await readNativeWorkspaceDocument(guide.nativePath, async (path) => new Uint8Array(await readFile(path)));
    assert.equal(await source.text(), 'PDF source bytes from a nested project folder.');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
