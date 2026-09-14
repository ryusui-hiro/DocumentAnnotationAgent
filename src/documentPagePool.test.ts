import assert from 'node:assert/strict';
import test from 'node:test';
import { runDocumentPagePool } from './documentPagePool';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('runs three independent pages simultaneously and never exceeds the cap', async () => {
  const releases = new Map<number, (value: string) => void>();
  const started: number[] = [];
  let active = 0, maximum = 0;
  const running = runDocumentPagePool({
    pages: [1, 2, 3, 4, 5], concurrency: 99, signal: new AbortController().signal,
    run: (page) => { started.push(page); maximum = Math.max(maximum, ++active); return new Promise<string>((resolve) => releases.set(page, (value) => { active--; resolve(value); })); },
  });
  assert.deepEqual(started, [1, 2, 3]);
  releases.get(2)!('page two'); await tick();
  assert.deepEqual(started, [1, 2, 3, 4], 'a completed page frees one slot without waiting for page one');
  releases.get(3)!('page three'); await tick();
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  releases.get(5)!('page five'); releases.get(1)!('page one'); releases.get(4)!('page four');
  const result = await running;
  assert.equal(maximum, 3);
  assert.equal(result.completed.get(1), 'page one');
  assert.equal(result.completed.get(2), 'page two');
  assert.equal(result.completed.size, 5);
  assert.deepEqual(result.failedPages, []);
  assert.deepEqual(result.activePages, []);
});

test('one failed page does not cancel or corrupt other page results', async () => {
  const failures: number[] = [];
  const result = await runDocumentPagePool({
    pages: [1, 2, 3, 4], signal: new AbortController().signal,
    run: async (page) => { if (page === 2) throw new Error('page two could not be read'); return `result-${page}`; },
    onFailure: (page) => failures.push(page),
  });
  assert.deepEqual(failures, [2]);
  assert.deepEqual(result.failedPages, [2]);
  assert.deepEqual([...result.completed.entries()].sort(), [[1, 'result-1'], [3, 'result-3'], [4, 'result-4']]);
});

test('cancels every active worker and leaves queued pages unstarted', async () => {
  const abort = new AbortController();
  const started: number[] = [], cancelled: number[] = [];
  const running = runDocumentPagePool({
    pages: [1, 2, 3, 4, 5, 6], signal: abort.signal,
    run: (page, signal) => { started.push(page); return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })); },
    onCancel: (page) => cancelled.push(page),
    onComplete: () => assert.fail('cancelled output became complete'),
    onFailure: () => assert.fail('explicit cancellation was classified as a provider error'),
  });
  assert.deepEqual(started, [1, 2, 3]);
  abort.abort();
  const result = await running;
  assert.deepEqual(cancelled.sort(), [1, 2, 3]);
  assert.deepEqual(result.queuedPages, [4, 5, 6]);
  assert.equal(result.completed.size, 0);
  assert.deepEqual(result.activePages, []);
});

test('an already cancelled run starts no jobs and duplicate pages are rejected', async () => {
  const abort = new AbortController(); abort.abort();
  const result = await runDocumentPagePool({ pages: [1, 2], signal: abort.signal, run: async () => assert.fail('job started after cancellation') });
  assert.deepEqual(result.queuedPages, [1, 2]);
  await assert.rejects(runDocumentPagePool({ pages: [1, 1], signal: abort.signal, run: async () => '' }), /only once/);
});
