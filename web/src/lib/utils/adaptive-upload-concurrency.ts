const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 6;
const SAMPLE_MS = 3000;

export class AdaptiveUploadConcurrency {
  concurrency = 2;
  private bytes = 0;
  private startedAt: number | undefined;
  private previousRate: number | undefined;

  record(bytes: number, now = performance.now()) {
    this.startedAt ??= now;
    this.bytes += bytes;
    const elapsed = now - this.startedAt;
    if (elapsed >= SAMPLE_MS) {
      const rate = this.bytes / elapsed;
      if (this.previousRate === undefined || rate > this.previousRate * 1.1) {
        this.concurrency = Math.min(MAX_CONCURRENCY, this.concurrency + 1);
      } else if (rate < this.previousRate * 0.8) {
        this.concurrency = Math.max(MIN_CONCURRENCY, this.concurrency - 1);
      }
      this.previousRate = rate;
      this.bytes = 0;
      this.startedAt = now;
    }
    return this.concurrency;
  }

  error() {
    this.concurrency = Math.max(MIN_CONCURRENCY, Math.floor(this.concurrency / 2));
    this.previousRate = undefined;
    this.startedAt = undefined;
    this.bytes = 0;
    return this.concurrency;
  }
}
