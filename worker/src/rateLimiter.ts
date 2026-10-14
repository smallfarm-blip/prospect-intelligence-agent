export class DomainRateLimiter {
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async wait(domain: string, extraDelayMs = 0): Promise<void> {
    const interval = Math.max(this.minIntervalMs, extraDelayMs);
    const last = this.lastRequestAt.get(domain);
    if (last !== undefined) {
      const remaining = last + interval - Date.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
    this.lastRequestAt.set(domain, Date.now());
  }
}
