import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localScreenshotPath, type ScreenshotKind } from "./archive.ts";
import type { BrowserProvider, ViewportSpec } from "./browser/provider.ts";
import { VIEWPORTS } from "./browser/provider.ts";
import { capturePage, type AccessStatus, type CaptureResult } from "./capture.ts";
import type { SiteConfig } from "./config.ts";
import type { CostTracker } from "./cost.ts";
import { pickContrastingPdps, productLinks, rankPlpCandidates, type PageLink } from "./discovery.ts";
import type { Logger } from "./logger.ts";
import { buildCaptureStates } from "./overlays.ts";
import type { DomainRateLimiter } from "./rateLimiter.ts";
import { isPathAllowed, type RobotsRules } from "./robots.ts";
import type { EvidenceRow, EvidenceStore } from "./store.ts";
import { canonicalizeUrl } from "./url.ts";

export interface CollectorDeps {
  provider: BrowserProvider;
  store: EvidenceStore;
  tracker: CostTracker;
  limiter: DomainRateLimiter;
  logger: Logger;
  pageTimeoutMs: number;
  maxPlpCandidates: number;
  outputDir: string;
}

export interface CompanyContext {
  runId: string;
  jobId: string;
  companyId: string;
  site: SiteConfig;
  robots: RobotsRules;
}

interface Target {
  slot: string;
  pageType: EvidenceRow["page_type"];
  url: string;
  discoveryMethod: string;
  discoveredFrom: string | null;
  notes: string[];
}

interface ViewportOutcome {
  viewport: ViewportSpec;
  result: CaptureResult | null;
  userAgent: string | null;
  status: AccessStatus;
  note: string | null;
}

export interface SlotSummary {
  slot: string;
  viewport: string;
  status: AccessStatus;
  url: string | null;
}

const RETRYABLE: AccessStatus[] = ["timeout", "error"];

export class CompanyCollector {
  private readonly summaries: SlotSummary[] = [];
  private domainBlocked: string | null = null;

  constructor(private readonly deps: CollectorDeps, private readonly ctx: CompanyContext) {}

  async run(): Promise<SlotSummary[]> {
    const { site, robots } = this.ctx;
    this.log("info", "company.start", { robots: robots.status, crawlDelay: robots.crawlDelaySeconds });

    const home = await this.captureTarget({
      slot: "homepage",
      pageType: "homepage",
      url: `https://${site.domain}/`,
      discoveryMethod: "canonical_domain",
      discoveredFrom: null,
      notes: [],
    });
    const homeLinks = linksOf(home.outcomes);

    const plp = await this.findPlp(homeLinks);
    const plpLinks = plp ? linksOf(plp.outcomes) : [];
    await this.capturePdps(plp?.url ?? null, plpLinks, homeLinks);

    this.log("info", "company.done", { units: this.deps.tracker.estimatedUnits });
    return this.summaries;
  }

  private async findPlp(homeLinks: PageLink[]): Promise<{ url: string; outcomes: ViewportOutcome[] } | null> {
    const { site } = this.ctx;
    const candidates = rankPlpCandidates(homeLinks, site.domain, this.deps.maxPlpCandidates);
    this.log("info", "discovery.plp_candidates", { candidates: candidates.map((c) => c.href) });

    for (const [i, candidate] of candidates.entries()) {
      if (this.stopReason()) break;
      const target: Target = {
        slot: "plp",
        pageType: "plp",
        url: candidate.href,
        discoveryMethod: candidate.inNav ? "nav_link_from_homepage" : "link_from_homepage",
        discoveredFrom: `https://${site.domain}/`,
        notes: [`PLP candidate ${i + 1} of ${candidates.length}, link text "${candidate.text}"`],
      };
      const attempt = await this.captureTarget(target, (r) => {
        const count = productLinks(r.links, site.domain).length;
        r.signals.productLinkCount = count;
        return count > 0;
      }, `plp_candidate_${i + 1}`);
      if (attempt.accepted) return { url: candidate.href, outcomes: attempt.outcomes };
    }

    if (site.fallback.plp && !this.stopReason()) {
      const attempt = await this.captureTarget(
        {
          slot: "plp",
          pageType: "plp",
          url: site.fallback.plp,
          discoveryMethod: "manual_fallback",
          discoveredFrom: null,
          notes: ["Automatic PLP discovery failed; used configured fallback URL"],
        },
        (r) => r.accessStatus === "captured",
        "plp_fallback",
      );
      if (attempt.accepted) return { url: site.fallback.plp, outcomes: attempt.outcomes };
    }

    const reason =
      this.stopReason() ??
      (homeLinks.length === 0
        ? "Homepage was not captured, so no links were available for discovery"
        : `No usable category/collection page among ${candidates.length} candidate link(s); see plp_candidate rows`);
    await this.recordUnattempted("plp", "plp", reason);
    return null;
  }

  private async capturePdps(plpUrl: string | null, plpLinks: PageLink[], homeLinks: PageLink[]): Promise<void> {
    const { site } = this.ctx;
    const picks: Array<{ link: PageLink; method: string; from: string | null; note: string }> = [];
    const fromPlp = pickContrastingPdps(productLinks(plpLinks, site.domain));
    fromPlp.forEach((link) =>
      picks.push({ link, method: "link_from_plp", from: plpUrl, note: "Chosen by position spread on listing; contrast not verified" }),
    );
    if (picks.length < 2) {
      for (const link of productLinks(homeLinks, site.domain)) {
        if (picks.length >= 2) break;
        if (picks.some((p) => p.link.href === link.href)) continue;
        picks.push({ link, method: "link_from_homepage", from: `https://${site.domain}/`, note: "Insufficient products on PLP; taken from homepage" });
      }
    }
    if (picks.length < 2) {
      for (const url of site.fallback.pdps) {
        if (picks.length >= 2) break;
        picks.push({ link: { href: url, text: "", inNav: false }, method: "manual_fallback", from: null, note: "Automatic PDP discovery failed; used configured fallback URL" });
      }
    }
    this.log("info", "discovery.pdps", { picks: picks.map((p) => `${p.method}:${p.link.href}`) });

    for (const slotIndex of [0, 1]) {
      const slot = `pdp_${slotIndex + 1}`;
      const pick = picks[slotIndex];
      if (!pick || this.stopReason()) {
        await this.recordUnattempted(slot, "pdp", this.stopReason() ?? "No product link found on PLP or homepage");
        continue;
      }
      await this.captureTarget({
        slot,
        pageType: "pdp",
        url: pick.link.href,
        discoveryMethod: pick.method,
        discoveredFrom: pick.from,
        notes: [pick.note],
      });
    }
  }

  private stopReason(): string | null {
    if (this.domainBlocked) return `Not attempted: site blocked an earlier page (${this.domainBlocked}); access controls are not bypassed`;
    if (this.deps.tracker.ceilingHit) return "Not attempted: per-run cost ceiling reached";
    return null;
  }

  /**
   * Captures a target at every viewport in one browser session, retrying no-response failures once
   * in a fresh session. When `accept` rejects the first viewport (or it was not captured), the
   * attempt is stored under `rejectedSlot` so the main slot keeps a single clear outcome.
   */
  private async captureTarget(
    target: Target,
    accept?: (r: CaptureResult) => boolean,
    rejectedSlot?: string,
  ): Promise<{ outcomes: ViewportOutcome[]; accepted: boolean }> {
    const url = new URL(target.url);
    let outcomes: ViewportOutcome[];
    if (!isPathAllowed(this.ctx.robots, url.pathname + url.search)) {
      const why = this.ctx.robots.status === "unreachable" ? "robots.txt unreachable (treated as disallow)" : "Disallowed by robots.txt";
      outcomes = VIEWPORTS.map((v) => ({ viewport: v, result: null, userAgent: null, status: "disallowed_by_robots" as const, note: why }));
    } else {
      outcomes = await this.runSession(target, VIEWPORTS, accept);
      const retry = outcomes.filter((o) => RETRYABLE.includes(o.status) && o.result?.httpStatus == null).map((o) => o.viewport);
      if (retry.length && !this.stopReason()) {
        this.log("warn", "capture.retry", { url: target.url, viewports: retry.map((v) => v.name) });
        const retried = await this.runSession({ ...target, notes: [...target.notes, "Retried once in a new browser session"] }, retry, accept);
        outcomes = outcomes.map((o) => retried.find((r) => r.viewport.name === o.viewport.name) ?? o);
      }
    }

    const first = outcomes[0];
    const accepted = !accept || (first.status === "captured" && !!first.result && accept(first.result));
    if (!accepted && rejectedSlot) {
      const why = first.status === "captured" ? "Rejected as PLP: no product links detected" : "Candidate not usable";
      const kept = outcomes
        .filter((o) => o.result || o.status !== "not_observed")
        .map((o) => ({ ...o, note: [o.note, why].filter(Boolean).join("; ") }));
      await this.persistAll({ ...target, slot: rejectedSlot }, kept);
      return { outcomes: kept, accepted: false };
    }
    await this.persistAll(target, outcomes);
    return { outcomes, accepted: true };
  }

  private async runSession(target: Target, viewports: ViewportSpec[], accept?: (r: CaptureResult) => boolean): Promise<ViewportOutcome[]> {
    if (!this.deps.tracker.canStartSession()) {
      return viewports.map((v) => ({ viewport: v, result: null, userAgent: null, status: "skipped_cost_ceiling", note: "Per-run cost ceiling reached" }));
    }

    const outcomes: ViewportOutcome[] = [];
    let session;
    try {
      session = await this.deps.provider.openSession();
    } catch (err) {
      const msg = `Browser session failed to open: ${(err as Error).message.split("\n")[0]}`;
      this.log("error", "session.open_failed", { error: msg });
      return viewports.map((v) => ({ viewport: v, result: null, userAgent: null, status: "error", note: msg }));
    }

    try {
      for (const viewport of viewports) {
        await this.deps.limiter.wait(this.ctx.site.domain, (this.ctx.robots.crawlDelaySeconds ?? 0) * 1000);
        let vp;
        try {
          vp = await session.openPage(viewport);
          const result = await capturePage(vp.page, target.url, { timeoutMs: this.deps.pageTimeoutMs, touch: viewport.hasTouch });
          outcomes.push({ viewport, result, userAgent: vp.userAgent, status: result.accessStatus, note: null });
          this.log(result.accessStatus === "captured" ? "info" : "warn", "capture.page", {
            slot: target.slot,
            viewport: viewport.name,
            status: result.accessStatus,
            http: result.httpStatus,
            ms: result.loadDurationMs,
            url: target.url,
            overlays: result.overlayDismissal?.status ?? null,
          });
          if (result.accessStatus === "blocked") break;
          if (accept && outcomes.length === 1 && result.accessStatus === "captured" && !accept(result)) break;
        } catch (err) {
          const msg = (err as Error).message.split("\n")[0];
          outcomes.push({ viewport, result: null, userAgent: null, status: "error", note: `Browser error: ${msg}` });
        } finally {
          await vp?.close();
        }
      }
    } finally {
      const ms = await session.close();
      const cost = this.deps.tracker.record(`${this.ctx.site.domain} ${target.slot}`, ms);
      this.log("info", "session.closed", { slot: target.slot, seconds: Math.round(ms / 100) / 10, estUnits: cost.estimatedUnits });
    }

    const blocked = outcomes.find((o) => o.status === "blocked");
    if (blocked) this.domainBlocked = `${target.slot}: ${blocked.result?.signals.blockReason ?? "blocked"}`;
    for (const v of viewports) {
      if (!outcomes.some((o) => o.viewport.name === v.name)) {
        const note = blocked ? "Not attempted: site blocked the previous viewport" : "Not attempted: page rejected at first viewport";
        outcomes.push({ viewport: v, result: null, userAgent: null, status: "not_observed", note });
      }
    }
    return outcomes;
  }

  private async persistAll(target: Target, outcomes: ViewportOutcome[]): Promise<void> {
    for (const o of outcomes) await this.persist(target, o);
  }

  private async persist(target: Target, o: ViewportOutcome): Promise<void> {
    const { runId, site } = this.ctx;
    const r = o.result;
    const base = `${runId}/${site.domain}/${target.slot}-${o.viewport.name}`;
    let screenshotPath: string | null = null;
    let fullPath: string | null = null;
    let unobstructedPath: string | null = null;
    const save = (kind: ScreenshotKind, suffix: string, body: Buffer, contentType: string) =>
      this.saveImage(`${base}${suffix}`, localScreenshotPath(site.domain, target.slot, o.viewport.name, kind), body, contentType);
    if (r?.viewportPng) screenshotPath = await save("initial", ".png", r.viewportPng, "image/png");
    if (r?.unobstructedPng) unobstructedPath = await save("after-dismissal", "-unobstructed.png", r.unobstructedPng, "image/png");
    if (r?.fullPageJpeg) fullPath = await save("full-page", "-full.jpg", r.fullPageJpeg, "image/jpeg");
    const dismissal = o.status === "captured" ? r?.overlayDismissal ?? null : null;

    const notes = [...target.notes, o.note].filter(Boolean).join(" | ") || null;
    await this.deps.store.insertEvidence({
      research_run_id: runId,
      company_id: this.ctx.companyId,
      job_id: this.ctx.jobId,
      page_type: target.pageType,
      page_slot: target.slot,
      requested_url: target.url,
      final_url: r?.finalUrl ? canonicalizeUrl(r.finalUrl) : null,
      viewport_name: o.viewport.name,
      viewport_width: o.viewport.width,
      viewport_height: o.viewport.height,
      user_agent: o.userAgent,
      captured_at: new Date().toISOString(),
      access_status: o.status,
      http_status: r?.httpStatus ?? null,
      page_title: r?.title ?? null,
      screenshot_path: screenshotPath,
      full_page_screenshot_path: fullPath,
      unobstructed_screenshot_path: unobstructedPath,
      overlay_dismissal_status: dismissal?.status ?? null,
      capture_states: dismissal
        ? buildCaptureStates(
            dismissal,
            { path: screenshotPath, at: r?.initialCapturedAt ?? null },
            { path: unobstructedPath, at: r?.unobstructedCapturedAt ?? null },
          )
        : [],
      extracted_text: r?.text ?? null,
      extracted_text_length: r?.textLength ?? null,
      content_hash: r?.contentHash ?? null,
      discovery_method: target.discoveryMethod,
      discovered_from_url: target.discoveredFrom,
      page_type_signals: r?.signals ?? {},
      navigation_notes: notes,
      error_message: r?.errorMessage ?? (o.status === "error" ? o.note : null),
      load_duration_ms: r?.loadDurationMs ?? null,
    });
    if (["homepage", "plp", "pdp_1", "pdp_2"].includes(target.slot)) {
      this.summaries.push({ slot: target.slot, viewport: o.viewport.name, status: o.status, url: r?.finalUrl ?? target.url });
    }
  }

  private async recordUnattempted(slot: string, pageType: EvidenceRow["page_type"], reason: string): Promise<void> {
    const status: AccessStatus = this.deps.tracker.ceilingHit && !this.domainBlocked ? "skipped_cost_ceiling" : "not_observed";
    for (const viewport of VIEWPORTS) {
      await this.persistUnattempted(slot, pageType, viewport, status, reason);
    }
  }

  private async persistUnattempted(
    slot: string,
    pageType: EvidenceRow["page_type"],
    viewport: ViewportSpec,
    status: AccessStatus,
    reason: string,
  ): Promise<void> {
    await this.deps.store.insertEvidence({
      research_run_id: this.ctx.runId,
      company_id: this.ctx.companyId,
      job_id: this.ctx.jobId,
      page_type: pageType,
      page_slot: slot,
      requested_url: null,
      final_url: null,
      viewport_name: viewport.name,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      user_agent: null,
      captured_at: new Date().toISOString(),
      access_status: status,
      http_status: null,
      page_title: null,
      screenshot_path: null,
      full_page_screenshot_path: null,
      unobstructed_screenshot_path: null,
      overlay_dismissal_status: null,
      capture_states: [],
      extracted_text: null,
      extracted_text_length: null,
      content_hash: null,
      discovery_method: "none",
      discovered_from_url: null,
      page_type_signals: {},
      navigation_notes: `${reason}. "Not observed" does not mean the page or feature does not exist.`,
      error_message: null,
      load_duration_ms: null,
    });
    this.summaries.push({ slot, viewport: viewport.name, status, url: null });
  }

  private async saveImage(storagePath: string, localPath: string, body: Buffer, contentType: string): Promise<string> {
    const local = join(this.deps.outputDir, localPath);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, body);
    return this.deps.store.uploadScreenshot(storagePath, body, contentType);
  }

  private log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}): void {
    this.deps.logger.log(level, event, { domain: this.ctx.site.domain, ...data });
  }
}

function linksOf(outcomes: ViewportOutcome[]): PageLink[] {
  return outcomes.flatMap((o) => (o.status === "captured" ? o.result?.links ?? [] : []));
}
