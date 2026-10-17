import type { VerificationStatus } from "./checks.ts";
import { FINDING_CLASSES, type Finding, type FindingClass, type PriorityLevel, type VerifierOutput } from "./schemas.ts";

export interface AssignedAssessment {
  finding_class: FindingClass;
  investigation_priority: PriorityLevel;
  notes: string[];
}

/** Higher is less mature. */
const maturity = (c: FindingClass) => FINDING_CLASSES.indexOf(c);

/**
 * Class can only be lowered from what the analyst proposed: by the verifier's recommendation, then by rules.
 * Priority is a separate judgement and is never derived from class.
 */
export function assignAssessment(f: Finding, evidence: VerificationStatus, verdict: VerifierOutput | null): AssignedAssessment {
  const notes: string[] = [];
  let cls: FindingClass = f.finding_class;
  const cap = (to: FindingClass, why: string) => {
    if (maturity(to) > maturity(cls)) {
      cls = to;
      notes.push(why);
    }
  };

  if (verdict) {
    const rec = verdict.opportunity_assessment.recommended_class;
    cap(rec, `Verifier recommended ${rec.replace(/_/g, " ")}: ${verdict.opportunity_assessment.reason}`);
    if (verdict.generic_check.generic || !verdict.decision_problem.meaningful) cap("low_value_observation", "Generic or not a meaningful visitor decision problem");
    if (!verdict.opportunity_assessment.existing_support_considered) cap("research_hypothesis", "Existing site support was not taken into account");
    if (verdict.opportunity_assessment.critical_gaps.length) cap("research_hypothesis", "The verifier found evidence gaps that could invalidate the recommendation");
  }
  if (evidence !== "supported") cap("research_hypothesis", `Evidence verification is ${evidence.replace(/_/g, " ")}, so the finding is not evidence-backed`);
  if (f.critical_unknowns.some((u) => u.severity === "could_invalidate")) cap("research_hypothesis", "An unresolved unknown could invalidate the finding");

  const priority = verdict?.opportunity_assessment.recommended_priority ?? f.investigation_priority.level;
  if (priority !== f.investigation_priority.level) notes.push(`Verifier set investigation priority to ${priority} (analyst proposed ${f.investigation_priority.level})`);
  return { finding_class: cls, investigation_priority: priority, notes };
}
