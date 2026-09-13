import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';

export const NODE_VERSION = 'v24.21.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'src-tauri', 'resources', 'desktop-runtime');
const CACHE = join(ROOT, '.cache', 'desktop-runtime');

export function desktopTarget(targetTriple) {
  if (/^(aarch64|arm64)-apple-darwin$/.test(targetTriple)) {
    return { targetTriple, platform: 'darwin', arch: 'arm64', archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, nativePlatform: 'darwin', nativeArch: 'arm64' };
  }
  if (/^x86_64-apple-darwin$/.test(targetTriple)) {
    return { targetTriple, platform: 'darwin', arch: 'x64', archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`, nativePlatform: 'darwin', nativeArch: 'x64' };
  }
  if (/^aarch64-pc-windows-msvc$/.test(targetTriple)) {
    return { targetTriple, platform: 'win32', arch: 'arm64', archive: `node-${NODE_VERSION}-win-arm64.zip`, nativePlatform: 'win32', nativeArch: 'arm64', windows: true };
  }
  if (/^x86_64-pc-windows-msvc$/.test(targetTriple)) {
    return { targetTriple, platform: 'win32', arch: 'x64', archive: `node-${NODE_VERSION}-win-x64.zip`, nativePlatform: 'win32', nativeArch: 'x64', windows: true };
  }
  if (/^aarch64-unknown-linux-gnu$/.test(targetTriple)) {
    return { targetTriple, platform: 'linux', arch: 'arm64', archive: `node-${NODE_VERSION}-linux-arm64.tar.gz`, nativePlatform: 'linux', nativeArch: 'arm64', nativeLibc: 'glibc' };
  }
  if (/^x86_64-unknown-linux-gnu$/.test(targetTriple)) {
    return { targetTriple, platform: 'linux', arch: 'x64', archive: `node-${NODE_VERSION}-linux-x64.tar.gz`, nativePlatform: 'linux', nativeArch: 'x64', nativeLibc: 'glibc' };
  }
  throw new Error(`Unsupported desktop target triple: ${targetTriple}. Supported targets: macOS x64/arm64, Windows x64/arm64, and Linux GNU x64/arm64.`);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

async function verifiedNodeArchive(spec) {
  await mkdir(CACHE, { recursive: true });
  const archivePath = join(CACHE, spec.archive);
  const baseUrl = `https://nodejs.org/dist/${NODE_VERSION}`;
  const checksumResponse = await fetch(`${baseUrl}/SHASUMS256.txt`);
  if (!checksumResponse.ok) throw new Error(`Could not retrieve Node.js checksums (${checksumResponse.status}).`);
  const checksums = await checksumResponse.text();
  const row = checksums.split(/\r?\n/).find((line) => line.trim().split(/\s+/).at(-1) === spec.archive);
  const expectedHash = row?.trim().split(/\s+/)[0];
  if (!expectedHash || !/^[a-f\d]{64}$/i.test(expectedHash)) throw new Error(`Node.js ${NODE_VERSION} has no checksum entry for ${spec.archive}.`);

  let validCached = false;
  try { validCached = (await sha256(archivePath)) === expectedHash; } catch { /* Cache miss; fetch the archive below. */ }
  if (!validCached) {
    await rm(archivePath, { force: true });
    await download(`${baseUrl}/${spec.archive}`, archivePath);
    if ((await sha256(archivePath)) !== expectedHash) {
      await rm(archivePath, { force: true });
      throw new Error(`SHA-256 verification failed for ${spec.archive}.`);
    }
  }
  return archivePath;
}

function npmInstall(runtimeDirectory, spec) {
  const args = ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'];
  const env = {
    ...process.env,
    npm_config_os: spec.nativePlatform,
    npm_config_cpu: spec.nativeArch,
    ...(spec.nativeLibc ? { npm_config_libc: spec.nativeLibc } : {}),
  };
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: runtimeDirectory, env, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: runtimeDirectory, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci failed for ${spec.targetTriple} (exit ${result.status ?? 'unknown'}).`);
}

async function copyApiSources(runtimeDirectory) {
  const sourceServer = join(ROOT, 'server');
  const destinationServer = join(runtimeDirectory, 'server');
  await cp(sourceServer, destinationServer, {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts') && !source.endsWith('.map'),
  });
  const sourceDirectory = join(runtimeDirectory, 'src');
  await mkdir(sourceDirectory, { recursive: true });
  for (const name of ['taskPlan.ts', 'types.ts']) await cp(join(ROOT, 'src', name), join(sourceDirectory, name));
  await cp(join(ROOT, 'scripts', 'desktop-api-launcher.mjs'), join(runtimeDirectory, 'desktop-api-launcher.mjs'));
  await mkdir(join(runtimeDirectory, 'public'), { recursive: true });
  await cp(join(ROOT, 'public', 'demo-specification.pdf'), join(runtimeDirectory, 'public', 'demo-specification.pdf'));
  await cp(join(ROOT, 'package.json'), join(runtimeDirectory, 'package.json'));
  await cp(join(ROOT, 'package-lock.json'), join(runtimeDirectory, 'package-lock.json'));
}

export async function extractWindowsNodeArchive(archivePath, outputNode) {
  const archive = await JSZip.loadAsync(await readFile(archivePath));
  const nodeEntry = Object.values(archive.files).find((entry) => !entry.dir && basename(entry.name).toLowerCase() === 'node.exe');
  if (!nodeEntry) throw new Error(`The Windows Node.js archive contains no node.exe: ${archivePath}`);
  await mkdir(dirname(outputNode), { recursive: true });
  await writeFile(outputNode, await nodeEntry.async('nodebuffer'));
}

async function extractNode(archivePath, runtimeDirectory, spec) {
  const outputNode = join(runtimeDirectory, 'bin', spec.windows ? 'node.exe' : 'node');
  await mkdir(join(runtimeDirectory, 'bin'), { recursive: true });
  if (spec.windows) {
    // Do not rely on platform-specific `tar` implementations accepting ZIP files.
    await extractWindowsNodeArchive(archivePath, outputNode);
    return;
  }

  const extraction = join(CACHE, `extract-${spec.targetTriple}`);
  await rm(extraction, { recursive: true, force: true });
  await mkdir(extraction, { recursive: true });
  const result = spawnSync('tar', ['-xf', archivePath, '-C', extraction], { stdio: 'inherit' });
  if (result.error) throw new Error(`The system 'tar' utility is required to unpack the bundled Node.js runtime: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Could not unpack Node.js ${NODE_VERSION} for ${spec.targetTriple}.`);
  const unpacked = (await readdir(extraction, { withFileTypes: true })).find((entry) => entry.isDirectory());
  if (!unpacked) throw new Error(`The downloaded Node.js archive was empty: ${spec.archive}`);
  const nodeFile = join(extraction, unpacked.name, 'bin', 'node');
  await stat(nodeFile);
  await cp(nodeFile, outputNode);

  // macOS Node builds link to libnode through an @rpath relative to bin/node.
  const sourceLib = join(extraction, unpacked.name, 'lib');
  try {
    const libraries = (await readdir(sourceLib)).filter((name) => /(?:\.dylib(?:\..*)?|\.so(?:\..*)?|\.dll)$/i.test(name));
    if (libraries.length) {
      await mkdir(join(runtimeDirectory, 'lib'), { recursive: true });
      for (const library of libraries) await cp(join(sourceLib, library), join(runtimeDirectory, 'lib', library));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await chmod(outputNode, 0o755);
}

function hostTriple() {
  return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
}

export async function prepareDesktopRuntime({
  targetTriple = process.env.ANNOTATION_STUDIO_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || hostTriple(),
  outputDirectory = OUTPUT,
} = {}) {
  const spec = desktopTarget(targetTriple);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, '.keep'), '');
  const archive = await verifiedNodeArchive(spec);
  await extractNode(archive, outputDirectory, spec);
  await copyApiSources(outputDirectory);
  npmInstall(outputDirectory, spec);
  await writeFile(join(outputDirectory, 'runtime-manifest.json'), `${JSON.stringify({ nodeVersion: NODE_VERSION, targetTriple, preparedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Prepared bundled Node.js ${NODE_VERSION} API runtime for ${targetTriple} at ${relative(ROOT, outputDirectory)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDesktopRuntime().catch((error) => {
    console.error(`Could not prepare the desktop API runtime: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
