import type { AnalysisLimits } from "./config.ts";
import { imageLabel, type EvidencePack, type PackImage, type PageView } from "./evidence.ts";
import { captureStateLabel } from "./captureStates.ts";
import type { ContentBlock } from "./model.ts";
import type { Claim } from "./claims.ts";
import type { Finding, VerifierOutput } from "./schemas.ts";

const KIND_NAMES: Record<string, string> = { consent: "cookie consent banner", promotional: "promotional pop-up", other: "other overlay" };

function overlayText(page: PageView): string {
  const o = page.overlays;
  const list = (items: Array<{ kind: string; label: string }>) => (items.length ? items.map((x) => `${KIND_NAMES[x.kind] ?? x.kind} ("${x.label}")`).join("; ") : "none");
  const lines = [
    `Overlay record (heuristic scanner; screenshots outrank it): status ${o.status ?? "not recorded"}`,
    `  detected on first visit: ${list(o.initial)}`,
    `  recorded as closed: ${list(o.removed)}`,
    `  still detected after dismissal: ${list(o.remaining)}`,
  ];
  if (o.legacyFormat) lines.push("  NOTE: earlier record format; cookie consent banners were not reliably detected, so 'all_dismissed' covers only the overlays listed above.");
  return lines.join("\n");
}

function pageImages(pack: EvidencePack, page: PageView): string {
  const items = page.imageRefs.map((ref) => {
    const img = pack.images.find((i) => i.ref === ref)!;
    const how = img.pageRef === page.ref ? "captured for this page" : `byte-identical copy of the image first stored under ${img.pageRef}`;
    return `${ref} (${captureStateLabel(img.captureState)}; ${how})`;
  });
  return `Images attributed to ${page.ref}: ${items.join("; ") || "none"}`;
}

function pageHeader(page: PageView, pack: EvidencePack): string {
  return [
    `### ${page.ref} | ${page.pageType} (${page.slot}) | ${page.viewport} ${page.viewportWidth}x${page.viewportHeight}`,
    `URL: ${page.url}`,
    page.title ? `Title: ${page.title}` : null,
    pageImages(pack, page),
    overlayText(page),
    page.notes.length ? `Notes: ${page.notes.join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const imageBlocks = (img: PackImage, page: PageView): ContentBlock[] => [
  { type: "text", text: imageLabel(img, page) },
  { type: "image", ref: img.ref, mediaType: "image/jpeg", data: img.jpeg, estimatedTokens: img.estimatedTokens },
];

const textBlock = (page: PageView, excerpt: string): ContentBlock => ({
  type: "text",
  text: `<page_text ref="${page.textRef}" page="${page.ref}" chars_shown="${excerpt.length}" chars_stored="${page.fullText.length}">\n${excerpt}\n</page_text>`,
});

export function analystContent(pack: EvidencePack): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: "text",
      text: [
        `Company: ${pack.company.name} (${pack.company.domain})`,
        `Research run: ${pack.researchRunId}`,
        `Pages: ${pack.pages.length}. Images: ${pack.images.length}.`,
        pack.warnings.length ? `Evidence warnings:\n- ${pack.warnings.join("\n- ")}` : "Evidence warnings: none",
        pack.unanalysed.length
          ? `Not sent (do not make claims about these regions):\n- ${pack.unanalysed.map((u) => `${u.pageRef} pixels ${u.fromY}-${u.toY}: ${u.reason}`).join("\n- ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  for (const page of pack.pages) {
    blocks.push({ type: "text", text: pageHeader(page, pack) });
    for (const ref of page.imageRefs) {
      const img = pack.images.find((i) => i.ref === ref)!;
      if (img.pageRef === page.ref) blocks.push(...imageBlocks(img, page));
      else
        blocks.push({
          type: "text",
          text: `${ref} (shown above under ${img.pageRef}) is byte-identical to this page's "${captureStateLabel(img.captureState)}" screenshot. It cannot by itself show which page this is; when citing it for ${page.ref}, also cite something that establishes this page's identity (${page.textRef} or another ${page.ref} image).`,
        });
    }
    blocks.push(textBlock(page, page.textExcerpt));
  }
  blocks.push({ type: "text", text: "Analyse this evidence and call the tool once. Zero findings is acceptable." });
  return blocks;
}

/**
 * Only the evidence a set of claims cites, plus first-load and first-clear-view shots of those pages.
 * `factPages` are the pages facts say they are about, so the verifier can check page identity
 * for byte-identical images attributed to more than one page.
 */
export function citedEvidence(
  pack: EvidencePack,
  refs: string[],
  factPages: string[],
  limits: Pick<AnalysisLimits, "maxVerifierImages" | "maxPageTextChars">,
): ContentBlock[] {
  const imageRefs = new Set<string>();
  const pageRefs = new Set<string>();
  const textPages = new Set<string>();
  for (const ref of refs) {
    const img = pack.images.find((i) => i.ref === ref);
    if (img) {
      imageRefs.add(ref);
      pageRefs.add(img.pageRef);
      continue;
    }
    const page = pack.pages.find((p) => p.textRef === ref);
    if (page) {
      pageRefs.add(page.ref);
      textPages.add(page.ref);
    }
  }
  for (const ref of factPages) if (pack.pages.some((p) => p.ref === ref)) pageRefs.add(ref);
  const ordered = [...imageRefs];
  for (const pageRef of pageRefs) {
    const page = pack.pages.find((p) => p.ref === pageRef)!;
    for (const ref of page.imageRefs) {
      const img = pack.images.find((i) => i.ref === ref)!;
      if (img.captureState !== "full_page_section" && !ordered.includes(ref)) ordered.push(ref);
    }
  }
  const sent = ordered.slice(0, limits.maxVerifierImages);
  const blocks: ContentBlock[] = [];
  for (const pageRef of pageRefs) {
    const page = pack.pages.find((p) => p.ref === pageRef)!;
    blocks.push({ type: "text", text: pageHeader(page, pack) });
    if (textPages.has(pageRef)) blocks.push(textBlock(page, page.fullText.slice(0, limits.maxPageTextChars)));
  }
  for (const ref of sent) {
    const img = pack.images.find((i) => i.ref === ref)!;
    blocks.push(...imageBlocks(img, pack.pages.find((p) => p.ref === img.pageRef)!));
  }
  if (ordered.length > sent.length) {
    blocks.push({ type: "text", text: `Not shown because of the image limit: ${ordered.slice(sent.length).join(", ")}. Treat claims that rely only on them as not demonstrated.` });
  }
  return blocks;
}

function opportunityFraming(f: Finding): string {
  const unknowns = f.critical_unknowns.length
    ? f.critical_unknowns.map((u) => `- [${u.severity.replace(/_/g, " ")}] ${u.unknown} (resolve via ${u.resolution_source.replace(/_/g, " ")}, effort ${u.resolution_effort}): ${u.why_it_matters}`).join("\n")
    : "- none listed";
  const p = f.investigation_priority;
  return [
    "Opportunity framing to assess (not claims of fact):",
    `Proposed class: ${f.finding_class.replace(/_/g, " ")}. ${f.class_rationale}`,
    `Proposed investigation priority: ${p.level}. Commercial relevance: ${p.commercial_relevance} Decision importance: ${p.decision_importance} Hypothesis strength: ${p.hypothesis_strength} Effort to resolve unknowns: ${p.effort_to_resolve_unknowns}`,
    `Possible next step: ${f.possible_next_step}`,
    `Critical unknowns:\n${unknowns}`,
  ].join("\n");
}

export function verifierContent(pack: EvidencePack, finding: Finding, claims: Claim[], limits: Pick<AnalysisLimits, "maxVerifierImages" | "maxPageTextChars">): ContentBlock[] {
  const claimText = claims
    .map((c) =>
      [
        `${c.id} [${c.type}] ${c.text}`,
        c.evidenceRefs.length ? `  cites: ${c.evidenceRefs.join(", ")}` : null,
        c.region ? `  region of ${c.region.image_ref}: x ${c.region.x}, y ${c.region.y}, w ${c.region.width}, h ${c.region.height}` : null,
        c.quote ? `  quoted: "${c.quote}"` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [
    { type: "text", text: `Claims to verify (about a ${finding.page_type} page):\n\n${claimText}` },
    { type: "text", text: opportunityFraming(finding) },
    { type: "text", text: "Evidence:" },
    ...citedEvidence(pack, claims.flatMap((c) => c.evidenceRefs), claims.flatMap((c) => (c.pageRef ? [c.pageRef] : [])), limits),
    { type: "text", text: "Check every claim ID and call the tool once." },
  ];
}

export function revisionContent(
  pack: EvidencePack,
  finding: Finding,
  verdict: VerifierOutput,
  reason: string,
  limits: Pick<AnalysisLimits, "maxVerifierImages" | "maxPageTextChars">,
): ContentBlock[] {
  return [
    { type: "text", text: `Finding to revise:\n${JSON.stringify(finding, null, 2)}` },
    { type: "text", text: `Verifier result:\n${JSON.stringify(verdict, null, 2)}\n\nSummary: ${reason}` },
    { type: "text", text: "Evidence:" },
    ...citedEvidence(pack, finding.observed_facts.flatMap((x) => x.evidence_refs), finding.observed_facts.map((x) => x.page_ref), limits),
  ];
}
