import type { StoredEvidence } from "../store.ts";
import { removedIn, type CaptureState, type DismissalStatus, type OverlayKind, type OverlaySummary } from "../overlays.ts";
import type { AnalysisLimits } from "./config.ts";
import { CAPTURE_STATE_TERMS } from "./captureStates.ts";
import { inspectImage, planSections, prepareRegion, sha256, type Crop } from "./images.ts";

export interface CompanyRef {
  id: string;
  name: string;
  domain: string;
}

/** Read-only access to stored Phase 0 evidence. Never opens a browser. */
export interface EvidenceSource {
  findCompany(domain: string): Promise<CompanyRef | null>;
  loadEvidence(researchRunId: string, companyId: string): Promise<StoredEvidence[]>;
  download(path: string): Promise<Buffer | null>;
}

export type ImageState = "initial_viewport" | "after_overlay_dismissal" | "full_page_section";

export interface OverlayBrief {
  kind: OverlayKind;
  label: string;
}

export interface PageOverlays {
  status: DismissalStatus | null;
  initial: OverlayBrief[];
  removed: OverlayBrief[];
  remaining: OverlayBrief[];
  actions: Array<{ kind: OverlayKind; control: string | null; outcome: string }>;
  /** Recorded before the after-state listed removed overlays; consent banners may have gone undetected. */
  legacyFormat: boolean;
}

export interface PageView {
  ref: string;
  textRef: string;
  evidenceId: string;
  pageType: string;
  slot: string;
  viewport: "desktop" | "mobile";
  viewportWidth: number;
  viewportHeight: number;
  url: string;
  title: string | null;
  capturedAt: string;
  textExcerpt: string;
  fullText: string;
  textLength: number;
  overlays: PageOverlays;
  imageRefs: string[];
  notes: string[];
}

export interface PackImage {
  ref: string;
  pageRef: string;
  evidenceId: string;
  captureState: ImageState;
  sourcePath: string;
  crop: Crop;
  sourceWidth: number;
  sourceHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  estimatedTokens: number;
  sha256: string;
  sourceSha256: string;
  alsoShownFor: string[];
  alsoShownForEvidenceIds: string[];
  jpeg: Buffer;
}

export interface UnanalysedRegion {
  pageRef: string;
  fromY: number;
  toY: number;
  reason: string;
}

export interface EvidencePack {
  researchRunId: string;
  company: CompanyRef;
  pages: PageView[];
  images: PackImage[];
  warnings: string[];
  unanalysed: UnanalysedRegion[];
  skipped: Array<{ evidenceId: string; slot: string; viewport: string; reason: string }>;
}

const brief = (o: OverlaySummary): OverlayBrief => ({ kind: o.kind, label: o.label.replace(/\s+/g, " ").slice(0, 140) });

export function overlaysOf(e: StoredEvidence): PageOverlays {
  const states = (e.capture_states ?? []) as CaptureState[];
  const initial = states.find((s) => s.state === "initial_viewport");
  const after = states.find((s) => s.state === "after_overlay_dismissal");
  return {
    status: e.overlay_dismissal_status,
    initial: (initial?.overlays_visible ?? []).map(brief),
    removed: after ? removedIn(after).map(brief) : [],
    remaining: (after?.overlays_visible ?? []).map(brief),
    actions: (after?.actions ?? []).map((a) => ({ kind: a.overlay.kind, control: a.control?.label ?? null, outcome: a.outcome })),
    legacyFormat: !!after && after.overlays_removed === undefined,
  };
}

const PRIORITY: Record<string, number> = { pdp: 0, plp: 1, homepage: 2 };
const order = (e: StoredEvidence) => (PRIORITY[e.page_type] ?? 3) * 2 + (e.viewport_name === "mobile" ? 0 : 1);

export async function loadEvidencePack(
  source: EvidenceSource,
  input: { researchRunId: string; companyDomain: string },
  limits: Pick<AnalysisLimits, "maxImages" | "maxSectionsPerPage" | "maxPageTextChars">,
): Promise<EvidencePack> {
  const company = await source.findCompany(input.companyDomain);
  if (!company) throw new Error(`No company with domain ${input.companyDomain}`);
  const rows = await source.loadEvidence(input.researchRunId, company.id);
  if (!rows.length) throw new Error(`Research run ${input.researchRunId} has no evidence for ${company.domain}`);

  const pack: EvidencePack = { researchRunId: input.researchRunId, company, pages: [], images: [], warnings: [], unanalysed: [], skipped: [] };
  const captured = rows.filter((r) => {
    if (r.access_status === "captured") return true;
    pack.skipped.push({ evidenceId: r.id, slot: r.page_slot, viewport: r.viewport_name, reason: `access_status ${r.access_status}` });
    return false;
  });
  if (!captured.length) throw new Error("No captured pages in this research run for this company");
  captured.sort((a, b) => order(a) - order(b) || a.page_slot.localeCompare(b.page_slot));

  const bySourceHash = new Map<string, PackImage>();
  const fullPages: Array<{ page: PageView; row: StoredEvidence }> = [];
  let imageSeq = 0;
  const nextRef = () => `IMG-${String(++imageSeq).padStart(2, "0")}`;

  const addImage = async (page: PageView, row: StoredEvidence, state: ImageState, path: string, buf: Buffer, crop: Crop | null, srcW: number, srcH: number) => {
    const srcHash = sha256(buf);
    const key = `${srcHash}:${crop ? `${crop.y}-${crop.height}` : "full"}`;
    const existing = bySourceHash.get(key);
    if (existing) {
      existing.alsoShownFor.push(page.ref);
      existing.alsoShownForEvidenceIds.push(row.id);
      page.imageRefs.push(existing.ref);
      page.notes.push(`${state} screenshot is byte-identical to ${existing.ref} (${existing.pageRef}); sent once.`);
      return;
    }
    const region = crop ?? { x: 0, y: 0, width: srcW, height: srcH };
    const prepared = await prepareRegion(buf, region);
    const img: PackImage = {
      ref: nextRef(),
      pageRef: page.ref,
      evidenceId: row.id,
      captureState: state,
      sourcePath: path,
      crop: region,
      sourceWidth: srcW,
      sourceHeight: srcH,
      scaledWidth: prepared.scaledWidth,
      scaledHeight: prepared.scaledHeight,
      estimatedTokens: prepared.estimatedTokens,
      sha256: sha256(prepared.jpeg),
      sourceSha256: srcHash,
      alsoShownFor: [],
      alsoShownForEvidenceIds: [],
      jpeg: prepared.jpeg,
    };
    bySourceHash.set(key, img);
    pack.images.push(img);
    page.imageRefs.push(img.ref);
  };

  const fetchChecked = async (page: PageView, label: string, path: string | null) => {
    if (!path) {
      page.notes.push(`No ${label} screenshot was stored.`);
      return null;
    }
    const buf = await source.download(path);
    if (!buf) {
      pack.warnings.push(`${page.ref} (${page.slot} ${page.viewport}): ${label} screenshot could not be downloaded (${path}).`);
      return null;
    }
    const info = await inspectImage(buf).catch(() => null);
    if (!info || !info.width || !info.height) {
      pack.warnings.push(`${page.ref}: ${label} screenshot is not a readable image (${path}).`);
      return null;
    }
    if (info.blank) {
      pack.warnings.push(`${page.ref}: ${label} screenshot is blank or a single colour; not sent to the model.`);
      return null;
    }
    const dpr = info.width / page.viewportWidth;
    if (!Number.isInteger(dpr) || dpr < 1) page.notes.push(`${label} image width ${info.width}px does not match viewport ${page.viewportWidth}px at a whole pixel ratio.`);
    return { buf, info, dpr: Math.max(1, Math.round(dpr)) };
  };

  for (const [i, row] of captured.entries()) {
    const fullText = row.extracted_text ?? "";
    const page: PageView = {
      ref: `P${i + 1}`,
      textRef: `TXT-P${i + 1}`,
      evidenceId: row.id,
      pageType: row.page_type,
      slot: row.page_slot,
      viewport: row.viewport_name,
      viewportWidth: row.viewport_width,
      viewportHeight: row.viewport_height,
      url: row.final_url ?? row.requested_url ?? "",
      title: row.page_title,
      capturedAt: row.captured_at,
      textExcerpt: fullText.slice(0, limits.maxPageTextChars),
      fullText,
      textLength: row.extracted_text_length ?? fullText.length,
      overlays: overlaysOf(row),
      imageRefs: [],
      notes: [],
    };
    if (!fullText) page.notes.push("No extracted text was stored for this page.");
    if (fullText.length > limits.maxPageTextChars) page.notes.push(`Text excerpt limited to the first ${limits.maxPageTextChars} of ${fullText.length} stored characters.`);
    if (page.overlays.legacyFormat) {
      page.notes.push(
        "Overlay records use the earlier format, captured before cookie banners were reliably detected. 'all_dismissed' covers only the overlays listed; confirm from the screenshot whether any banner remains.",
      );
    }
    pack.pages.push(page);

    const viewportShots = [
      { label: "initial", state: "initial_viewport" as const, path: row.screenshot_path },
      { label: "after-dismissal", state: "after_overlay_dismissal" as const, path: row.unobstructed_screenshot_path },
    ];
    for (const shot of viewportShots) {
      if (pack.images.length >= limits.maxImages) {
        page.notes.push(`${shot.label} screenshot not sent: image limit for this analysis reached.`);
        pack.warnings.push(`${page.ref} (${page.slot} ${page.viewport}): ${shot.label} screenshot not sent because the image limit was reached.`);
        continue;
      }
      const checked = await fetchChecked(page, shot.label, shot.path);
      if (checked) await addImage(page, row, shot.state, shot.path!, checked.buf, null, checked.info.width, checked.info.height);
    }
    fullPages.push({ page, row });
  }

  for (const { page, row } of fullPages) {
    if (!row.full_page_screenshot_path) {
      page.notes.push("No full-page screenshot was stored; only the first screen is available.");
      continue;
    }
    const remaining = limits.maxImages - pack.images.length;
    const full = await fetchChecked(page, "full-page", row.full_page_screenshot_path);
    if (!full) continue;
    const sectionHeight = page.viewportHeight * full.dpr;
    const plan = planSections(full.info.width, full.info.height, sectionHeight, Math.min(limits.maxSectionsPerPage, Math.max(0, remaining)));
    for (const crop of plan.sections) {
      await addImage(page, row, "full_page_section", row.full_page_screenshot_path, full.buf, crop, full.info.width, full.info.height);
    }
    if (plan.unanalysed) {
      const reason = remaining <= 0 ? "image limit for this analysis reached" : `section limit (${limits.maxSectionsPerPage} per page) reached`;
      pack.unanalysed.push({ pageRef: page.ref, ...plan.unanalysed, reason });
    }
  }

  const sharedInitial = pack.images.filter((i) => i.captureState === "initial_viewport" && i.alsoShownFor.length);
  for (const img of sharedInitial) {
    pack.warnings.push(
      `${CAPTURE_STATE_TERMS.initial_viewport.label} screenshots for ${[img.pageRef, ...img.alsoShownFor].join(", ")} are byte-identical (${img.ref}). This usually means the same full-screen overlay covered each page; treat them as overlay-only, not page content. The image alone cannot show which page it is: establish each page's identity from its URL, title, page text or its own ${CAPTURE_STATE_TERMS.after_overlay_dismissal.label} screenshot.`,
    );
  }
  if (pack.pages.some((p) => p.overlays.legacyFormat)) {
    pack.warnings.push("Some pages use the earlier overlay record format; overlay metadata may omit cookie banners that are visible in screenshots.");
  }
  if (pack.unanalysed.length) {
    pack.warnings.push(`${pack.unanalysed.length} full-page region(s) were not sent to the model; see unanalysed regions.`);
  }
  return pack;
}

/** Every page an image was captured for: the page it was first stored under, then byte-identical copies. */
export function imagePages(img: PackImage): string[] {
  return [img.pageRef, ...img.alsoShownFor];
}

export function imageLabel(img: PackImage, page: PageView): string {
  const where =
    img.captureState === "full_page_section"
      ? `${CAPTURE_STATE_TERMS.full_page_section.label} | this full-page section, source pixels y ${img.crop.y}-${img.crop.y + img.crop.height} of ${img.sourceHeight}, was captured after closing pop-ups`
      : `${CAPTURE_STATE_TERMS[img.captureState].label} | ${CAPTURE_STATE_TERMS[img.captureState].meaning}`;
  const shared = img.alsoShownFor.length
    ? ` | captured for ${page.ref} and, as byte-identical copies, for ${img.alsoShownFor.join(", ")}; the image alone does not identify the page`
    : ` | captured for ${page.ref} only`;
  return `${img.ref} | ${page.ref} ${page.slot} ${page.viewport} | ${where} | ${img.scaledWidth}x${img.scaledHeight}px${shared}`;
}

/** Everything about the pack except image bytes, for storage and audit. */
export function manifestOf(pack: EvidencePack) {
  return {
    researchRunId: pack.researchRunId,
    company: pack.company,
    pages: pack.pages.map(({ fullText: _full, textExcerpt, ...p }) => ({ ...p, textExcerptChars: textExcerpt.length })),
    images: pack.images.map(({ jpeg: _jpeg, ...i }) => i),
    unanalysed: pack.unanalysed,
    skipped: pack.skipped,
    warnings: pack.warnings,
  };
}
