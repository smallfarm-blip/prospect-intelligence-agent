import type {
  AnalysisImage,
  AssessmentOverride,
  Finding,
  FindingClass,
  OutreachReadiness,
  PageEvidence,
  PriorityLevel,
  ReadinessDecision,
  Review,
  RunDetail,
  Verification,
} from '@/lib/types';
import { assessmentOf, type FindingAssessment } from '@/lib/assessment';

export interface FindingView {
  finding: Finding;
  verification: Verification | null;
  reviews: Review[];
  overrides: AssessmentOverride[];
  readiness: ReadinessDecision[];
  assessment: FindingAssessment;
  revisedFrom: Finding | null;
  revisions: Finding[];
}

export function findingViews(detail: RunDetail): FindingView[] {
  const byId = new Map(detail.findings.map((f) => [f.id, f]));
  return detail.findings.map((finding) => {
    const verification = detail.verifications.find((v) => v.finding_id === finding.id) ?? null;
    const overrides = detail.overrides.filter((o) => o.finding_id === finding.id);
    const readiness = detail.readiness.filter((r) => r.finding_id === finding.id);
    return {
      finding,
      verification,
      reviews: detail.reviews.filter((r) => r.finding_id === finding.id),
      overrides,
      readiness,
      assessment: assessmentOf(finding, verification, overrides, readiness),
      revisedFrom: finding.revision_of ? byId.get(finding.revision_of) ?? null : null,
      revisions: detail.findings.filter((f) => f.revision_of === finding.id),
    };
  });
}

export interface CitedImage {
  image: AnalysisImage;
  /** Every page this exact image was captured for; more than one means byte-identical captures. */
  pages: PageEvidence[];
  regions: Array<{ x: number; y: number; width: number; height: number; factId: string }>;
  factIds: string[];
}

export function citedImages(detail: RunDetail, finding: Finding): CitedImage[] {
  const out = new Map<string, CitedImage>();
  for (const fact of finding.content.observed_facts) {
    for (const ref of fact.evidence_refs) {
      const image = detail.images.find((i) => i.ref === ref);
      if (!image) continue;
      const pageIds = [image.page_evidence_id, ...(image.also_captured_for_evidence_ids ?? [])];
      const entry = out.get(ref) ?? {
        image,
        pages: pageIds.map((id) => detail.pages.find((p) => p.id === id)).filter((p): p is PageEvidence => !!p),
        regions: [],
        factIds: [],
      };
      if (!entry.factIds.includes(fact.fact_id)) entry.factIds.push(fact.fact_id);
      if (fact.region && fact.region.image_ref === ref) entry.regions.push({ ...fact.region, factId: fact.fact_id });
      out.set(ref, entry);
    }
  }
  return [...out.values()];
}

export function citedPages(detail: RunDetail, finding: Finding): PageEvidence[] {
  const ids = new Set(citedImages(detail, finding).flatMap((c) => c.pages.map((p) => p.id)));
  for (const e of detail.evidence) if (e.finding_id === finding.id) ids.add(e.page_evidence_id);
  return detail.pages.filter((p) => ids.has(p.id));
}

export function imageUrl(image: AnalysisImage, urls: Record<string, string>): string | null {
  return urls[image.derived_path ?? image.source_path] ?? null;
}

export type SortKey = 'analysis' | 'priority' | 'class';

export interface ViewFilters {
  findingClass: FindingClass | 'all';
  priority: PriorityLevel | 'all';
  readiness: OutreachReadiness | 'undecided' | 'all';
  sort: SortKey;
}

export const DEFAULT_FILTERS: ViewFilters = { findingClass: 'all', priority: 'all', readiness: 'all', sort: 'analysis' };

const PRIORITY_ORDER: Record<PriorityLevel, number> = { high: 0, medium: 1, low: 2 };
const CLASS_ORDER: Record<FindingClass, number> = { evidence_backed_opportunity: 0, research_hypothesis: 1, low_value_observation: 2 };

/** Keeps the analysis order unless the reviewer explicitly picks a sort; maturity never ranks findings by default. */
export function filterViews(views: FindingView[], f: ViewFilters): FindingView[] {
  const kept = views.filter(({ assessment: a }) =>
    (f.findingClass === 'all' || a.findingClass.value === f.findingClass) &&
    (f.priority === 'all' || a.priority.value === f.priority) &&
    (f.readiness === 'all' || (a.readiness?.readiness ?? 'undecided') === f.readiness),
  );
  if (f.sort === 'analysis') return kept;
  const rank = (v: FindingView) =>
    f.sort === 'priority'
      ? v.assessment.priority.value ? PRIORITY_ORDER[v.assessment.priority.value] : 9
      : v.assessment.findingClass.value ? CLASS_ORDER[v.assessment.findingClass.value] : 9;
  return [...kept].sort((a, b) => rank(a) - rank(b));
}

export function isLegacyFinding(finding: Finding): boolean {
  return !finding.schema_version;
}
