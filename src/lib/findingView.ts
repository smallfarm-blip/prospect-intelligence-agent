import type { AnalysisImage, Finding, PageEvidence, Review, RunDetail, Verification } from '@/lib/types';

export interface FindingView {
  finding: Finding;
  verification: Verification | null;
  reviews: Review[];
  revisedFrom: Finding | null;
  revisions: Finding[];
}

export function findingViews(detail: RunDetail): FindingView[] {
  const byId = new Map(detail.findings.map((f) => [f.id, f]));
  return detail.findings.map((finding) => ({
    finding,
    verification: detail.verifications.find((v) => v.finding_id === finding.id) ?? null,
    reviews: detail.reviews.filter((r) => r.finding_id === finding.id),
    revisedFrom: finding.revision_of ? byId.get(finding.revision_of) ?? null : null,
    revisions: detail.findings.filter((f) => f.revision_of === finding.id),
  }));
}

export interface CitedImage {
  image: AnalysisImage;
  page: PageEvidence | null;
  regions: Array<{ x: number; y: number; width: number; height: number; factId: string }>;
  factIds: string[];
}

export function citedImages(detail: RunDetail, finding: Finding): CitedImage[] {
  const out = new Map<string, CitedImage>();
  for (const fact of finding.content.observed_facts) {
    for (const ref of fact.evidence_refs) {
      const image = detail.images.find((i) => i.ref === ref);
      if (!image) continue;
      const entry = out.get(ref) ?? { image, page: detail.pages.find((p) => p.id === image.page_evidence_id) ?? null, regions: [], factIds: [] };
      if (!entry.factIds.includes(fact.fact_id)) entry.factIds.push(fact.fact_id);
      if (fact.region && fact.region.image_ref === ref) entry.regions.push({ ...fact.region, factId: fact.fact_id });
      out.set(ref, entry);
    }
  }
  return [...out.values()];
}

export function citedPages(detail: RunDetail, finding: Finding): PageEvidence[] {
  const ids = new Set(citedImages(detail, finding).map((c) => c.image.page_evidence_id));
  for (const e of detail.evidence) if (e.finding_id === finding.id) ids.add(e.page_evidence_id);
  return detail.pages.filter((p) => ids.has(p.id));
}

export function imageUrl(image: AnalysisImage, urls: Record<string, string>): string | null {
  return urls[image.derived_path ?? image.source_path] ?? null;
}
