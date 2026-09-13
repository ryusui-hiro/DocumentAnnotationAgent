import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { desktopTarget, extractWindowsNodeArchive, NODE_VERSION } from './prepare-tauri-runtime.mjs';

test('desktop runtime maps supported Tauri triples to matching Node distributions and npm native packages', () => {
  assert.equal(NODE_VERSION, 'v24.21.0');
  assert.deepEqual(desktopTarget('aarch64-apple-darwin'), {
    targetTriple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64',
    archive: 'node-v24.21.0-darwin-arm64.tar.gz', nativePlatform: 'darwin', nativeArch: 'arm64',
  });
  assert.equal(desktopTarget('x86_64-apple-darwin').archive, 'node-v24.21.0-darwin-x64.tar.gz');
  assert.equal(desktopTarget('aarch64-pc-windows-msvc').nativePlatform, 'win32');
  assert.equal(desktopTarget('x86_64-pc-windows-msvc').archive, 'node-v24.21.0-win-x64.zip');
  assert.equal(desktopTarget('aarch64-unknown-linux-gnu').nativeLibc, 'glibc');
  assert.equal(desktopTarget('x86_64-unknown-linux-gnu').nativeArch, 'x64');
});

test('desktop runtime rejects unbundled or unsupported Linux C runtimes', () => {
  assert.throws(() => desktopTarget('x86_64-unknown-linux-musl'), /Unsupported desktop target triple/);
  assert.throws(() => desktopTarget('i686-pc-windows-msvc'), /Unsupported desktop target triple/);
});

test('Windows Node ZIP extraction reads node.exe directly without invoking tar', async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-windows-node-zip-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const archivePath = join(temporaryDirectory, 'node.zip');
  const outputNode = join(temporaryDirectory, 'bin', 'node.exe');
  const expectedBytes = Buffer.from('test Windows executable bytes');
  const archive = new JSZip();
  archive.file('node-v24.21.0-win-arm64/node.exe', expectedBytes);
  archive.file('node-v24.21.0-win-arm64/LICENSE', 'license text');
  await writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer' }));

  await extractWindowsNodeArchive(archivePath, outputNode);

  assert.deepEqual(await readFile(outputNode), expectedBytes);
});

test('Windows Node ZIP extraction reports a missing node.exe clearly', async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'annotation-studio-windows-node-zip-empty-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const archivePath = join(temporaryDirectory, 'node.zip');
  const archive = new JSZip();
  archive.file('node-v24.21.0-win-x64/LICENSE', 'license text');
  await writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer' }));

  await assert.rejects(
    extractWindowsNodeArchive(archivePath, join(temporaryDirectory, 'node.exe')),
    /contains no node\.exe/,
  );
});
