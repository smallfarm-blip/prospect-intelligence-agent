import type { AssessmentField, AssessmentOverride, Finding, FindingClass, OutreachReadiness, PriorityLevel, ReadinessDecision, Verification } from '@/lib/types';

export const CLASS_LABELS: Record<FindingClass, string> = {
  evidence_backed_opportunity: 'Evidence-backed opportunity',
  research_hypothesis: 'Research hypothesis',
  low_value_observation: 'Low-value observation',
};

export const CLASS_DESCRIPTIONS: Record<FindingClass, string> = {
  evidence_backed_opportunity: 'The evidence directly shows the problem and nothing critical is unknown.',
  research_hypothesis: 'Plausible and worth investigating, but rests on untested behaviour or open questions.',
  low_value_observation: 'Accurate, but unlikely to matter commercially.',
};

export const PRIORITY_LABELS: Record<PriorityLevel, string> = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

export const READINESS_LABELS: Record<OutreachReadiness, string> = {
  not_ready: 'Not for outreach',
  exploratory: 'Exploratory outreach only',
  ready: 'Ready for outreach',
};

export const CLASSES = Object.keys(CLASS_LABELS) as FindingClass[];
export const PRIORITIES = Object.keys(PRIORITY_LABELS) as PriorityLevel[];

export type AssessmentSource = 'reviewer' | 'verification' | 'analyst';

export interface Effective<T> {
  value: T | null;
  source: AssessmentSource | null;
  /** What the system assigned before any reviewer change. */
  system: T | null;
}

/** Same precedence as the database's effective_assessment(): latest reviewer change, then verification, then analyst. */
function effective<T extends string>(field: AssessmentField, finding: Finding, verification: Verification | null, overrides: AssessmentOverride[]): Effective<T> {
  const fromVerification = (field === 'finding_class' ? verification?.assigned_class : verification?.assigned_priority) ?? null;
  const fromAnalyst = (field === 'finding_class' ? finding.finding_class : finding.investigation_priority) ?? null;
  const system = (fromVerification ?? fromAnalyst) as T | null;
  const latest = overrides.find((o) => o.field === field);
  if (latest) return { value: latest.new_value as T, source: 'reviewer', system };
  return { value: system, source: fromVerification ? 'verification' : fromAnalyst ? 'analyst' : null, system };
}

export interface FindingAssessment {
  findingClass: Effective<FindingClass>;
  priority: Effective<PriorityLevel>;
  readiness: ReadinessDecision | null;
}

/** `overrides` and `readiness` must be newest first. */
export function assessmentOf(finding: Finding, verification: Verification | null, overrides: AssessmentOverride[], readiness: ReadinessDecision[]): FindingAssessment {
  return {
    findingClass: effective<FindingClass>('finding_class', finding, verification, overrides),
    priority: effective<PriorityLevel>('investigation_priority', finding, verification, overrides),
    readiness: readiness[0] ?? null,
  };
}

export const SOURCE_LABELS: Record<AssessmentSource, string> = {
  reviewer: 'changed by a reviewer',
  verification: 'assigned after verification',
  analyst: 'proposed by the analyst',
};

export function fieldValueLabel(field: AssessmentField, value: string | null): string {
  if (!value) return 'Not set';
  return field === 'finding_class' ? CLASS_LABELS[value as FindingClass] ?? value : PRIORITY_LABELS[value as PriorityLevel] ?? value;
}
