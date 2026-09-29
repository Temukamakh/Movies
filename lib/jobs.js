/** Runs background tasks one at a time and exposes their progress to the UI. */
export class JobQueue {
  constructor(log) {
    this.log = log;
    this.queue = [];
    this.current = null;
    this.waiters = [];
  }

  has(key) {
    return this.current?.key === key || this.queue.some((j) => j.key === key);
  }

  add(key, info, run) {
    if (this.has(key)) return;
    this.queue.push({ key, ...info, status: 'queued', progress: 0, run });
    this.next();
  }

  /** Drops queued jobs for an item and aborts the running one. */
  cancel(itemId) {
    this.queue = this.queue.filter((j) => j.itemId !== itemId);
    if (this.current?.itemId === itemId) this.current.controller.abort();
  }

  async next() {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) {
      this.waiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    this.current = job;
    job.status = 'running';
    job.controller = new AbortController();
    try {
      await job.run(job, job.controller.signal);
    } catch (err) {
      if (!job.controller.signal.aborted) this.log(`${job.label}: ${err.message}`);
    } finally {
      this.current = null;
      setImmediate(() => this.next());
    }
  }

  list() {
    return [this.current, ...this.queue]
      .filter(Boolean)
      .map(({ key, type, itemId, label, status, progress }) => ({ key, type, itemId, label, status, progress }));
  }

  /** Resolves once nothing is queued or running (used by tests). */
  idle() {
    return this.current || this.queue.length ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }
}
