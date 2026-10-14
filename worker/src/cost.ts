export const MS_PER_UNIT = 30_000;

export function unitsForSession(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / MS_PER_UNIT));
}

export interface SessionCost {
  label: string;
  durationMs: number;
  estimatedUnits: number;
}

export class CostTracker {
  readonly sessions: SessionCost[] = [];
  ceilingHit = false;

  constructor(
    private readonly maxUnits: number,
    private readonly maxCostUsd: number,
    private readonly unitPriceUsd: number,
    private readonly sessionTimeoutMs: number,
  ) {}

  get estimatedUnits(): number {
    return this.sessions.reduce((sum, s) => sum + s.estimatedUnits, 0);
  }

  get sessionSeconds(): number {
    return this.sessions.reduce((sum, s) => sum + s.durationMs, 0) / 1000;
  }

  get estimatedCostUsd(): number {
    return round(this.estimatedUnits * this.unitPriceUsd);
  }

  /** Allows a new session only if its worst case (killed at the session timeout) stays within both ceilings. */
  canStartSession(): boolean {
    const worstUnits = this.estimatedUnits + unitsForSession(this.sessionTimeoutMs);
    const ok = worstUnits <= this.maxUnits && worstUnits * this.unitPriceUsd <= this.maxCostUsd;
    if (!ok) this.ceilingHit = true;
    return ok;
  }

  record(label: string, durationMs: number): SessionCost {
    const entry = { label, durationMs, estimatedUnits: unitsForSession(durationMs) };
    this.sessions.push(entry);
    return entry;
  }
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
