import type { AnalysisLimits } from "./config.ts";
import { imageLabel, type EvidencePack, type PackImage, type PageView } from "./evidence.ts";
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

function pageHeader(page: PageView): string {
  return [
    `### ${page.ref} | ${page.pageType} (${page.slot}) | ${page.viewport} ${page.viewportWidth}x${page.viewportHeight}`,
    `URL: ${page.url}`,
    page.title ? `Title: ${page.title}` : null,
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
    blocks.push({ type: "text", text: pageHeader(page) });
    for (const ref of page.imageRefs) {
      const img = pack.images.find((i) => i.ref === ref)!;
      if (img.pageRef === page.ref) blocks.push(...imageBlocks(img, page));
      else blocks.push({ type: "text", text: `${ref} (shown above for ${img.pageRef}) is also this page's ${img.captureState.replace(/_/g, " ")} screenshot.` });
    }
    blocks.push(textBlock(page, page.textExcerpt));
  }
  blocks.push({ type: "text", text: "Analyse this evidence and call the tool once. Zero findings is acceptable." });
  return blocks;
}

/** Only the evidence a set of claims cites, plus first-visit and after-dismissal shots of those pages. */
export function citedEvidence(pack: EvidencePack, refs: string[], limits: Pick<AnalysisLimits, "maxVerifierImages" | "maxPageTextChars">): ContentBlock[] {
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
    blocks.push({ type: "text", text: pageHeader(page) });
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
    { type: "text", text: "Evidence:" },
    ...citedEvidence(pack, claims.flatMap((c) => c.evidenceRefs), limits),
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
    ...citedEvidence(pack, finding.observed_facts.flatMap((x) => x.evidence_refs), limits),
  ];
}
