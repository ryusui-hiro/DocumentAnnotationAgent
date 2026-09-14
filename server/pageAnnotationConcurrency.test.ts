import assert from 'node:assert/strict';
import test from 'node:test';
import { PageAnnotationConcurrency } from './pageAnnotationConcurrency';

test('three distinct pages run concurrently, same-page work and a fourth page are rejected', () => {
  const slots = new PageAnnotationConcurrency();
  const releases = [1, 2, 3].map((page) => slots.acquire('document', page));
  assert.deepEqual(slots.activePages('document'), [1, 2, 3]);
  assert.throws(() => slots.acquire('document', 2), (error: unknown) => (error as { status: number; code: string }).status === 409 && (error as { code: string }).code === 'page_in_progress');
  assert.throws(() => slots.acquire('document', 4), (error: unknown) => (error as { status: number; code: string }).status === 409 && (error as { code: string }).code === 'document_concurrency_limit');
  const other = slots.acquire('another-document', 1);
  releases[0]!();
  const fourth = slots.acquire('document', 4);
  assert.deepEqual(slots.activePages('document'), [2, 3, 4]);
  releases.forEach((release) => release()); fourth(); other();
  assert.deepEqual(slots.activePages('document'), []);
});

test('old or duplicate releases cannot clear a later lease for the same page', () => {
  const slots = new PageAnnotationConcurrency();
  const old = slots.acquire('document', 1); old();
  const current = slots.acquire('document', 1); old();
  assert.deepEqual(slots.activePages('document'), [1]);
  current(); current();
  assert.deepEqual(slots.activePages('document'), []);
});

test('failed, aborted, and pre-aborted work cannot leak concurrency slots', async () => {
  const slots = new PageAnnotationConcurrency();
  await assert.rejects(slots.run('document', 1, async () => { throw new Error('Provider failure'); }), /Provider failure/);
  assert.deepEqual(slots.activePages('document'), []);
  const controller = new AbortController();
  const running = slots.run('document', 2, () => new Promise<void>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  }), controller.signal);
  controller.abort();
  await assert.rejects(running, /abort/i);
  assert.deepEqual(slots.activePages('document'), []);
  let called = false;
  await assert.rejects(slots.run('document', 3, async () => { called = true; }, controller.signal), /abort/i);
  assert.equal(called, false);
  assert.deepEqual(slots.activePages('document'), []);
});
