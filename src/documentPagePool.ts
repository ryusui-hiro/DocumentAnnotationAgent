export type PagePoolProgress = {
  total: number;
  activePages: number[];
  completedPages: number[];
  failedPages: number[];
  cancelledPages: number[];
  queuedPages: number[];
};

/** Page jobs share cancellation but never share their result or failure state. */
export async function runDocumentPagePool<T>(args: {
  pages: number[];
  concurrency?: number;
  signal: AbortSignal;
  run: (pageNumber: number, signal: AbortSignal) => Promise<T>;
  onStart?: (pageNumber: number) => void;
  onComplete?: (pageNumber: number, result: T) => void;
  onFailure?: (pageNumber: number, error: unknown) => void;
  onCancel?: (pageNumber: number) => void;
  onProgress?: (progress: PagePoolProgress) => void;
}) {
  if (args.pages.some((page) => !Number.isSafeInteger(page) || page < 1)) throw new Error('Page numbers must be positive integers.');
  if (new Set(args.pages).size !== args.pages.length) throw new Error('Each page may be scheduled only once.');
  const concurrency = Math.min(3, Math.max(1, Number.isFinite(args.concurrency) ? Math.floor(args.concurrency!) : 3));
  const active = new Set<number>();
  const completed = new Map<number, T>();
  const failed = new Map<number, unknown>();
  const cancelled = new Set<number>();
  let next = 0;
  const progress = (): PagePoolProgress => ({
    total: args.pages.length, activePages: [...active], completedPages: [...completed.keys()],
    failedPages: [...failed.keys()], cancelledPages: [...cancelled], queuedPages: args.pages.slice(next),
  });
  const emit = () => args.onProgress?.(progress());
  const worker = async () => {
    while (!args.signal.aborted && next < args.pages.length) {
      const pageNumber = args.pages[next++];
      active.add(pageNumber); args.onStart?.(pageNumber); emit();
      try {
        const result = await args.run(pageNumber, args.signal);
        if (args.signal.aborted) { cancelled.add(pageNumber); args.onCancel?.(pageNumber); }
        else { completed.set(pageNumber, result); args.onComplete?.(pageNumber, result); }
      } catch (error) {
        if (args.signal.aborted) { cancelled.add(pageNumber); args.onCancel?.(pageNumber); }
        else { failed.set(pageNumber, error); args.onFailure?.(pageNumber, error); }
      } finally { active.delete(pageNumber); emit(); }
    }
  };
  emit();
  await Promise.all(Array.from({ length: Math.min(concurrency, args.pages.length) }, worker));
  return { completed, failed, ...progress() };
}
