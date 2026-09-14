import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const recordFormat = 1;
const maximumPlaintextBytes = 256 * 1024 * 1024;
type EncryptedRecord = { version: 1; iv: string; tag: string; content: string };

function safePart(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Private record name contains unsupported characters.');
  return value;
}

function containedPath(directory: string, ...parts: string[]) {
  const root = resolve(directory);
  const target = resolve(root, ...parts);
  const rootPrefix = root === sep ? root : `${root}${sep}`;
  if (target === root || !target.startsWith(rootPrefix)) throw new Error('Private record path escaped its storage directory.');
  return target;
}

export function createPrivateRecordStore(directory: string) {
  const keyPath = containedPath(directory, 'record-key');

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  async function encryptionKey() {
    await ensureDirectory();
    try {
      const existing = await readFile(keyPath);
      if (existing.byteLength !== 32) throw new Error('Private record encryption key has an invalid length.');
      return existing;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const key = randomBytes(32);
    try {
      const file = await open(keyPath, 'wx', 0o600);
      try {
        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }
      return key;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await readFile(keyPath);
      if (existing.byteLength !== 32) throw new Error('Private record encryption key has an invalid length.');
      return existing;
    }
  }

  function recordPath(namespace: string, id: string) {
    return containedPath(directory, safePart(namespace), `${safePart(id)}.json`);
  }

  return {
    async put(namespace: string, id: string, value: unknown) {
      const plaintext = Buffer.from(JSON.stringify(value));
      if (plaintext.byteLength > maximumPlaintextBytes) throw new Error('Private record exceeds the local storage limit.');
      const compressed = gzipSync(plaintext, { level: 6 });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
      const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const envelope: EncryptedRecord = {
        version: recordFormat,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        content: ciphertext.toString('base64'),
      };
      const target = recordPath(namespace, id);
      const parent = containedPath(directory, safePart(namespace));
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const temporary = containedPath(parent, `.${safePart(id)}-${randomBytes(8).toString('hex')}.tmp`);
      await open(temporary, 'wx', 0o600).then(async (file) => {
        try {
          await file.writeFile(JSON.stringify(envelope));
          await file.sync();
        } finally {
          await file.close();
        }
      });
      await rename(temporary, target);
    },

    async get<T>(namespace: string, id: string): Promise<T | null> {
      let content: Buffer;
      try {
        content = await readFile(recordPath(namespace, id));
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
      let envelope: EncryptedRecord;
      try {
        envelope = JSON.parse(content.toString('utf8')) as EncryptedRecord;
      } catch {
        throw new Error('Private record is not valid JSON.');
      }
      if (envelope.version !== recordFormat) throw new Error('Private record format is not supported.');
      const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const compressed = Buffer.concat([decipher.update(Buffer.from(envelope.content, 'base64')), decipher.final()]);
      const plaintext = gunzipSync(compressed, { maxOutputLength: maximumPlaintextBytes });
      return JSON.parse(plaintext.toString('utf8')) as T;
    },

    async delete(namespace: string, id: string) {
      try {
        await unlink(recordPath(namespace, id));
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },

    async list(namespace: string) {
      const parent = containedPath(directory, safePart(namespace));
      try {
        return (await readdir(parent)).filter((fileName) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(fileName)).map((fileName) => fileName.slice(0, -5));
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

export const privateRecordStore = createPrivateRecordStore(
  process.env.ANNOTATION_STUDIO_DATA_DIR ?? join(homedir(), '.annotation-studio', 'session-state'),
);
