/** Owns independent per-page leases; callers release their lease in finally. */
export class PageAnnotationConcurrency {
  private readonly documents = new Map<string, Map<number, symbol>>();
  constructor(readonly limit = 3) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Page concurrency must be a positive integer.');
  }

  acquire(documentId: string, pageNumber: number): () => void {
    if (!documentId.trim() || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 120) {
      throw Object.assign(new Error('A document and valid page are required.'), { status: 400 });
    }
    const pages = this.documents.get(documentId) ?? new Map<number, symbol>();
    if (pages.has(pageNumber)) throw Object.assign(new Error('This page is already being analyzed.'), { status: 409, code: 'page_in_progress' });
    if (pages.size >= this.limit) throw Object.assign(new Error(`Up to ${this.limit} pages of this document can be analyzed at once. Wait for a page to finish.`), { status: 409, code: 'document_concurrency_limit' });
    const token = Symbol('page-annotation-lease');
    pages.set(pageNumber, token);
    this.documents.set(documentId, pages);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (pages.get(pageNumber) !== token) return;
      pages.delete(pageNumber);
      if (pages.size === 0 && this.documents.get(documentId) === pages) this.documents.delete(documentId);
    };
  }

  activePages(documentId: string): number[] {
    return [...(this.documents.get(documentId)?.keys() ?? [])].sort((left, right) => left - right);
  }

  /** A failed or aborted provider promise always frees its page slot. */
  async run<T>(documentId: string, pageNumber: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const release = this.acquire(documentId, pageNumber);
    try { return await work(); }
    finally { release(); }
  }
}
