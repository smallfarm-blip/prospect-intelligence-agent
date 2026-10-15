import { createHash } from "node:crypto";
import { errors, type Frame, type Page } from "playwright-core";
import {
  OVERLAY_SCAN_FRAME_SCRIPT,
  OVERLAY_SCAN_PAGE_SCRIPT,
  PAGE_LINKS_SCRIPT,
  PAGE_SIGNALS_SCRIPT,
  PAGE_TEXT_SCRIPT,
  SCROLL_THROUGH_SCRIPT,
} from "./browser/pageScripts.ts";
import type { PageLink } from "./discovery.ts";
import { dismissOverlays, type DetectedOverlay, type DismissalResult, type OverlayControl, type OverlayDriver } from "./overlays.ts";

export type AccessStatus =
  | "captured"
  | "blocked"
  | "timeout"
  | "error"
  | "not_observed"
  | "disallowed_by_robots"
  | "skipped_cost_ceiling";

export interface PageSignals {
  jsonLdTypes: string[];
  ogType: string | null;
  addToCartControlVisible: boolean;
  visibleDialogCount: number;
  productLinkCount?: number;
  blockReason?: string;
  fullPageScreenshotError?: string;
  fullPageState?: "after_overlay_dismissal";
}

export interface CaptureResult {
  accessStatus: AccessStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  title: string | null;
  viewportPng: Buffer | null;
  initialCapturedAt: string | null;
  unobstructedPng: Buffer | null;
  unobstructedCapturedAt: string | null;
  overlayDismissal: DismissalResult | null;
  fullPageJpeg: Buffer | null;
  text: string | null;
  textLength: number | null;
  contentHash: string | null;
  signals: PageSignals;
  links: PageLink[];
  loadDurationMs: number;
  errorMessage: string | null;
}

const TEXT_LIMIT = 20_000;
const BLOCK_TITLE = /(access denied|attention required|just a moment|are you a robot|verify you are human|request blocked|pardon our interruption|security check)/i;
const BLOCK_TEXT = /(captcha|verify you are (a )?human|enable javascript and cookies to continue|checking your browser|unusual traffic)/i;

/** Returns why a response looks like an access control rather than real content, or null. */
export function detectBlock(httpStatus: number | null, title: string, textSample: string): string | null {
  if (httpStatus === 401 || httpStatus === 403) return `HTTP ${httpStatus}`;
  if (httpStatus === 429) return "HTTP 429 (rate limited)";
  if (BLOCK_TITLE.test(title)) return `challenge page title: "${title.slice(0, 80)}"`;
  if (textSample.length < 1500 && BLOCK_TEXT.test(textSample)) return "challenge or CAPTCHA text on page";
  return null;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
}

async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(SCROLL_THROUGH_SCRIPT);
  await page.waitForTimeout(500);
}

function emptySignals(): PageSignals {
  return { jsonLdTypes: [], ogType: null, addToCartControlVisible: false, visibleDialogCount: 0 };
}

const FRAME_SCAN_TIMEOUT_MS = 3_000;

interface PageScan {
  overlays: Array<Omit<DetectedOverlay, "frameUrl">>;
}

interface FrameScan {
  kind: DetectedOverlay["kind"];
  label: string;
  controls: OverlayControl[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Reads overlays from the page and from any overlay iframes (e.g. SMS/email pop-ups served in a frame). */
async function scanOverlays(page: Page): Promise<DetectedOverlay[]> {
  const scan = await page.evaluate<PageScan>(OVERLAY_SCAN_PAGE_SCRIPT);
  const overlays: DetectedOverlay[] = scan.overlays.map((o) => ({ ...o, frameUrl: null }));
  const frameOverlays = overlays.filter((o) => o.isFrame);
  if (!frameOverlays.length) return overlays;

  const children = page.frames().filter((f: Frame) => f.parentFrame() === page.mainFrame());
  for (const frame of children) {
    try {
      const box = await withTimeout(frame.frameElement().then((el) => el.boundingBox()), FRAME_SCAN_TIMEOUT_MS);
      if (!box) continue;
      const match = frameOverlays.find((o) => Math.abs(o.box.x - box.x) <= 3 && Math.abs(o.box.y - box.y) <= 3 && Math.abs(o.box.width - box.width) <= 3);
      if (!match) continue;
      const inner = await withTimeout(frame.evaluate<FrameScan>(OVERLAY_SCAN_FRAME_SCRIPT), FRAME_SCAN_TIMEOUT_MS);
      if (!inner) continue;
      match.frameUrl = frame.url();
      if (match.kind === "other") match.kind = inner.kind;
      if (!match.label) match.label = inner.label;
      match.controls = inner.controls.map((c) => ({ ...c, x: Math.round(c.x + box.x), y: Math.round(c.y + box.y) }));
    } catch {
      /* detached or inaccessible frame: overlay stays recorded without controls */
    }
  }
  return overlays;
}

function playwrightDriver(page: Page, touch: boolean): OverlayDriver {
  return {
    scan: () => scanOverlays(page),
    activate: (x, y) => (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y)),
    currentUrl: () => page.url(),
    wait: (ms) => page.waitForTimeout(ms),
  };
}

export interface CaptureOptions {
  timeoutMs: number;
  touch: boolean;
}

export async function capturePage(page: Page, url: string, opts: CaptureOptions): Promise<CaptureResult> {
  const started = Date.now();
  const base: CaptureResult = {
    accessStatus: "error",
    httpStatus: null,
    finalUrl: null,
    title: null,
    viewportPng: null,
    initialCapturedAt: null,
    unobstructedPng: null,
    unobstructedCapturedAt: null,
    overlayDismissal: null,
    fullPageJpeg: null,
    text: null,
    textLength: null,
    contentHash: null,
    signals: emptySignals(),
    links: [],
    loadDurationMs: 0,
    errorMessage: null,
  };

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    await settle(page);
    base.httpStatus = response?.status() ?? null;
    base.finalUrl = page.url();
    base.title = await page.title();

    const fullText = await page.evaluate<string>(PAGE_TEXT_SCRIPT);
    base.text = fullText.slice(0, TEXT_LIMIT);
    base.textLength = fullText.length;
    base.contentHash = createHash("sha256").update(fullText).digest("hex");

    base.signals = await page.evaluate<PageSignals>(PAGE_SIGNALS_SCRIPT);
    base.links = await page.evaluate<PageLink[]>(PAGE_LINKS_SCRIPT);

    // State 1: exactly what a first-time visitor sees, overlays included. Never altered afterwards.
    base.initialCapturedAt = new Date().toISOString();
    base.viewportPng = await page.screenshot({ type: "png", timeout: 15_000 });

    const blockReason = detectBlock(base.httpStatus, base.title, base.text);
    if (blockReason) {
      base.accessStatus = "blocked";
      base.signals.blockReason = blockReason;
    } else if (base.httpStatus !== null && base.httpStatus >= 400) {
      base.accessStatus = "error";
      base.errorMessage = `HTTP ${base.httpStatus}`;
    } else {
      base.accessStatus = "captured";
      await captureUnobstructed(page, base, opts.touch);
      if (base.overlayDismissal?.status === "navigated_away") {
        base.signals.fullPageScreenshotError = "Skipped: an overlay control navigated away from the page";
      } else {
        try {
          await scrollThrough(page);
          base.fullPageJpeg = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, timeout: 20_000 });
          base.signals.fullPageState = "after_overlay_dismissal";
        } catch (err) {
          base.signals.fullPageScreenshotError = (err as Error).message.slice(0, 300);
        }
      }
    }
  } catch (err) {
    base.accessStatus = err instanceof errors.TimeoutError ? "timeout" : "error";
    base.errorMessage = (err as Error).message.split("\n")[0].slice(0, 500);
  }

  base.loadDurationMs = Date.now() - started;
  return base;
}

/** State 2: the page after trying to close overlays with their own visible controls. */
async function captureUnobstructed(page: Page, base: CaptureResult, touch: boolean): Promise<void> {
  try {
    base.overlayDismissal = await dismissOverlays(playwrightDriver(page, touch), { method: touch ? "tap" : "click" });
  } catch (err) {
    base.overlayDismissal = {
      status: "error",
      initialOverlays: [],
      actions: [],
      remainingOverlays: [],
      error: (err as Error).message.split("\n")[0].slice(0, 300),
    };
  }
  if (base.overlayDismissal.status === "navigated_away") return;
  try {
    base.unobstructedCapturedAt = new Date().toISOString();
    base.unobstructedPng = await page.screenshot({ type: "png", timeout: 15_000 });
  } catch (err) {
    base.unobstructedCapturedAt = null;
    base.overlayDismissal.error = `Post-dismissal screenshot failed: ${(err as Error).message.split("\n")[0].slice(0, 200)}`;
  }
}
