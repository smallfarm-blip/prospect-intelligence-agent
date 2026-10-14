import { createHash } from "node:crypto";
import { errors, type Page } from "playwright-core";
import type { PageLink } from "./discovery.ts";

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
}

export interface CaptureResult {
  accessStatus: AccessStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  title: string | null;
  viewportPng: Buffer | null;
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
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let i = 0; i < 8 && window.scrollY + step < document.body.scrollHeight; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

function emptySignals(): PageSignals {
  return { jsonLdTypes: [], ogType: null, addToCartControlVisible: false, visibleDialogCount: 0 };
}

export async function capturePage(page: Page, url: string, timeoutMs: number): Promise<CaptureResult> {
  const started = Date.now();
  const base: CaptureResult = {
    accessStatus: "error",
    httpStatus: null,
    finalUrl: null,
    title: null,
    viewportPng: null,
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
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await settle(page);
    base.httpStatus = response?.status() ?? null;
    base.finalUrl = page.url();
    base.title = await page.title();

    const fullText = await page.evaluate(() => document.body?.innerText ?? "");
    base.text = fullText.slice(0, TEXT_LIMIT);
    base.textLength = fullText.length;
    base.contentHash = createHash("sha256").update(fullText).digest("hex");

    base.signals = await page.evaluate(() => {
      const types: string[] = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
        try {
          const collect = (node: unknown): void => {
            if (Array.isArray(node)) return node.forEach(collect);
            if (node && typeof node === "object") {
              const t = (node as Record<string, unknown>)["@type"];
              if (typeof t === "string") types.push(t);
              if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
              const graph = (node as Record<string, unknown>)["@graph"];
              if (graph) collect(graph);
            }
          };
          collect(JSON.parse(el.textContent ?? ""));
        } catch {
          /* malformed JSON-LD is ignored */
        }
      });
      const isVisible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const addToCart = [...document.querySelectorAll("button, input[type=submit], a")].some(
        (el) => /add to (cart|bag)/i.test((el as HTMLElement).innerText || (el as HTMLInputElement).value || "") && isVisible(el),
      );
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(isVisible);
      return {
        jsonLdTypes: [...new Set(types)],
        ogType: document.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? null,
        addToCartControlVisible: addToCart,
        visibleDialogCount: dialogs.length,
      };
    });

    base.links = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: ((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120),
        inNav: !!a.closest("nav, header, [role=navigation]"),
      })),
    );

    // Above-the-fold first, before any scrolling changes what is shown.
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
      try {
        await scrollThrough(page);
        base.fullPageJpeg = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, timeout: 20_000 });
      } catch (err) {
        base.signals.fullPageScreenshotError = (err as Error).message.slice(0, 300);
      }
    }
  } catch (err) {
    base.accessStatus = err instanceof errors.TimeoutError ? "timeout" : "error";
    base.errorMessage = (err as Error).message.split("\n")[0].slice(0, 500);
  }

  base.loadDurationMs = Date.now() - started;
  return base;
}
