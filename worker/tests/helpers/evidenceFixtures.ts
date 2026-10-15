import sharp from "sharp";
import type { StoredEvidence } from "../../src/store.ts";
import type { CaptureState, OverlaySummary } from "../../src/overlays.ts";
import type { CompanyRef, EvidenceSource } from "../../src/analysis/evidence.ts";

export const COMPANY: CompanyRef = { id: "co-1", name: "Kosas", domain: "kosas.com" };
export const RUN = "run-1";

/** A non-blank PNG: horizontal stripes whose colour depends on the seed so images differ. */
export async function png(width: number, height: number, seed = 0): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 40) % 2;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = band ? 230 : (seed * 37) % 200;
      raw[i + 1] = band ? 230 : (seed * 91) % 200;
      raw[i + 2] = band ? 230 : 40;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

export async function blankPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}

const overlay = (kind: OverlaySummary["kind"], label: string, control: string): OverlaySummary => ({
  kind,
  label,
  tag: "div",
  isFrame: false,
  frameUrl: null,
  coverage: kind === "consent" ? 0.15 : 0.6,
  box: { x: 0, y: 0, width: 100, height: 50 },
  controlsFound: [{ label: control, intent: kind === "consent" ? "decline" : "close", pressable: true }],
});
export const COOKIE = overlay("consent", "We use cookies to improve your experience", "Decline");
export const PROMO = overlay("promotional", "Get 15% off your first order", "Close");

/**
 * legacy: the earlier record format (no overlays_removed) that detected only the promo.
 * Otherwise both overlays are detected and closed.
 */
export function captureStates(opts: { legacy?: boolean } = {}): CaptureState[] {
  const detected = opts.legacy ? [PROMO] : [PROMO, COOKIE];
  const after: CaptureState = {
    state: "after_overlay_dismissal",
    screenshot_path: "after.png",
    captured_at: "t2",
    overlays_visible: [],
    dismissal_status: "all_dismissed",
    actions: detected.map((o) => ({
      overlay: o,
      firstSeen: "initial",
      control: { label: o.controlsFound[0].label, intent: o.controlsFound[0].intent, tag: "button" },
      method: "tap",
      outcome: "dismissed",
      detail: "closed",
    })),
    error: null,
    note: "after",
  };
  if (!opts.legacy) after.overlays_removed = detected;
  return [{ state: "initial_viewport", screenshot_path: "initial.png", captured_at: "t1", overlays_visible: detected, note: "initial" }, after];
}

let seq = 0;
export function evidenceRow(slot: string, viewport: "desktop" | "mobile", overrides: Partial<StoredEvidence> = {}): StoredEvidence {
  const pageType = slot.startsWith("pdp") ? "pdp" : slot === "homepage" ? "homepage" : "plp";
  const base = `${RUN}/kosas.com/${slot}-${viewport}`;
  return {
    id: `ev-${String(++seq).padStart(4, "0")}`,
    research_run_id: RUN,
    company_id: COMPANY.id,
    job_id: "j1",
    page_type: pageType,
    page_slot: slot,
    requested_url: `https://kosas.com/${slot}`,
    final_url: `https://kosas.com/${slot}`,
    viewport_name: viewport,
    viewport_width: viewport === "desktop" ? 200 : 100,
    viewport_height: viewport === "desktop" ? 120 : 200,
    user_agent: "UA",
    captured_at: "2026-01-01T00:00:00Z",
    access_status: "captured",
    http_status: 200,
    page_title: `Kosas ${slot}`,
    screenshot_path: `${base}.png`,
    full_page_screenshot_path: `${base}-full.png`,
    unobstructed_screenshot_path: `${base}-unobstructed.png`,
    overlay_dismissal_status: "all_dismissed",
    capture_states: captureStates(),
    extracted_text: `Revealer Concealer. Add to bag $28. Free shipping on orders over $35. ${slot}`,
    extracted_text_length: 70,
    content_hash: "h",
    discovery_method: "test",
    discovered_from_url: null,
    page_type_signals: {},
    navigation_notes: null,
    error_message: null,
    load_duration_ms: 1000,
    ...overrides,
  };
}

export class FakeSource implements EvidenceSource {
  downloads: string[] = [];
  constructor(
    private readonly rows: StoredEvidence[],
    readonly files: Map<string, Buffer>,
  ) {}
  async findCompany(domain: string) {
    return domain === COMPANY.domain ? COMPANY : null;
  }
  async loadEvidence(runId: string, companyId: string) {
    return this.rows.filter((r) => r.research_run_id === runId && r.company_id === companyId);
  }
  async download(path: string) {
    this.downloads.push(path);
    return this.files.get(path) ?? null;
  }
}

/** Builds rows plus distinct, readable images for each stored path. */
export async function standardFixture(rows: StoredEvidence[], fullHeightScreens = 3): Promise<FakeSource> {
  const files = new Map<string, Buffer>();
  let s = 1;
  for (const r of rows) {
    const w = r.viewport_width;
    const h = r.viewport_height;
    if (r.screenshot_path) files.set(r.screenshot_path, await png(w, h, s++));
    if (r.unobstructed_screenshot_path) files.set(r.unobstructed_screenshot_path, await png(w, h, s++));
    if (r.full_page_screenshot_path) files.set(r.full_page_screenshot_path, await png(w, h * fullHeightScreens, s++));
  }
  return new FakeSource(rows, files);
}

export const LIMITS = { maxImages: 40, maxSectionsPerPage: 4, maxPageTextChars: 6000 };
