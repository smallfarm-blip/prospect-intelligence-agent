import { TARGET_ROLES, type Assessment, type AssessmentKey, type AssessmentLevel, type QualificationInput, type Reading } from "./qualification.ts";
import { revenueBand, type RevenueBand } from "./scoring.ts";
import { byKind } from "./signalEvidence.ts";
import type { DecisionMaker, FitStatus, Signal } from "./types.ts";

export const NEXT_ACTIONS = ["verify_commercial_capacity", "validate_business_need", "confirm_decision_maker", "investigate_website", "defer"] as const;
export type NextActionKey = (typeof NEXT_ACTIONS)[number];

export const NEXT_ACTION_LABELS: Record<NextActionKey, string> = {
  verify_commercial_capacity: "Verify commercial capacity",
  validate_business_need: "Validate business need",
  confirm_decision_maker: "Confirm decision-maker",
  investigate_website: "Investigate website",
  defer: "Defer",
};

export interface NextAction {
  key: NextActionKey;
  label: string;
  /** Why this question matters most right now. */
  explanation: string;
  /** What to actually do, kept proportionate to the evidence. */
  step: string;
  evidence: string[];
  keyUnknown: string;
  /** Investigation value, 0-100: realistic consulting potential plus how promising the open question is. */
  priority: number;
}

export interface NextActionInput extends QualificationInput {
  assessments: Assessment[];
  fitStatus: FitStatus;
  excludedReason: string | null;
}

const known = (r: Reading) => r.status !== "unknown" && r.status !== "contradicted" && r.value !== null;
const shown = (l: AssessmentLevel) => l === "strong" || l === "moderate";
const who = (d: DecisionMaker) => `${d.name}${d.title ? ` (${d.title})` : ""}`;
const matureStack = (r: Reading) => r.status !== "unknown" && r.status !== "contradicted" && r.match === "mismatch";

const FIT_POINTS: Record<FitStatus, number> = { verified_fit: 30, probable_fit: 24, needs_qualification: 14, not_fit: 0 };
const BAND_POINTS: Record<RevenueBand, number> = { core_sweet_spot: 22, core: 20, above_core: 12, below_core: 10, outside_primary: 4, well_below_core: 0 };
const NEED_POINTS: Record<AssessmentLevel, number> = { strong: 20, moderate: 14, unknown: 7, weak: 4 };
const RELEVANCE_POINTS: Record<AssessmentLevel, number> = { strong: 8, moderate: 5, unknown: 2, weak: 0 };
const ACCESS_POINTS: Record<AssessmentLevel, number> = { strong: 10, moderate: 7, unknown: 3, weak: 2 };

function buyerOf(dms: DecisionMaker[]): { state: "confirmed" | "possible" | "none"; line: string } {
  const confirmed = dms.find((d) => d.review === "confirmed" && TARGET_ROLES.has(d.roleCategory));
  if (confirmed) return { state: "confirmed", line: `Confirmed decision-maker: ${who(confirmed)}` };
  const possible = dms.find((d) => d.review === null && TARGET_ROLES.has(d.roleCategory) && d.matchConfidence !== "low");
  if (possible) return { state: "possible", line: `Possible decision-maker, not confirmed: ${who(possible)}` };
  return { state: "none", line: "No decision-maker identified" };
}

/** A specific, sourced reason to look at the site: an observed problem, a capability gap, or a supported friction hypothesis. */
function hypotheses(signals: Signal[]): Signal[] {
  const k = byKind(signals);
  const supported = (s: Signal) => s.confidence !== "low" && s.sourceUrls.length > 0;
  return [...k.experience_problem, ...k.capability_gap, ...k.friction_hypothesis].filter(supported);
}

/**
 * Picks the single unresolved question most likely to change whether the company deserves attention.
 * Order matters: unsuitability first, then capacity (only while it is genuinely open), then need, then the buyer.
 */
export function selectNextAction(i: NextActionInput): NextAction {
  const a = Object.fromEntries(i.assessments.map((x) => [x.key, x])) as Record<AssessmentKey, Assessment>;
  const cap = a.commercial_capacity;
  const need = a.need_for_help;
  const access = a.accessibility;
  const rel = a.opportunity_relevance;
  const signals = [...i.experienceSignals, ...i.businessSignals];
  const buyer = buyerOf(i.decisionMakers);
  const band = known(i.revenue) ? revenueBand(i.revenue.value!) : null;
  const funded = known(i.funding) && i.funding.match === "match";
  const capacityEstablished = (band !== null && band !== "well_below_core") || funded;
  const hyp = hypotheses(signals);

  const priority = Math.round(
    FIT_POINTS[i.fitStatus] +
      (band ? BAND_POINTS[band] : funded ? 8 : 0) +
      NEED_POINTS[need.level] +
      (!shown(need.level) && hyp.length ? 4 : 0) +
      RELEVANCE_POINTS[rel.level] +
      ACCESS_POINTS[access.level],
  );
  const make = (key: NextActionKey, explanation: string, step: string, evidence: string[], keyUnknown: string, p = priority): NextAction => ({
    key,
    label: NEXT_ACTION_LABELS[key],
    explanation,
    step,
    evidence: [...new Set(evidence.filter(Boolean))].slice(0, 5),
    keyUnknown,
    priority: Math.max(0, Math.min(100, p)),
  });
  const triggers = byKind(i.businessSignals).commercial_trigger.map((s) => `Business activity: ${s.title}`);

  const deferReason =
    i.fitStatus === "not_fit" ? (i.excludedReason ? `Set aside: ${i.excludedReason}` : "Verified evidence places it outside the ICP")
    : band === "outside_primary" && matureStack(i.experimentation) ? `Revenue ${i.revenue.label} with a mature testing stack (${i.experimentation.label}); unlikely to need or buy a $4,500 sprint`
    : band === "well_below_core" && !funded && !shown(need.level) ? `Revenue ${i.revenue.label} with no funding or demonstrated need; very unlikely to fund a $4,500 sprint`
    : null;
  if (deferReason) {
    return make("defer", `${deferReason}. Further research is unlikely to change the decision.`, "Defer. Reopen only if new evidence changes the picture.", [deferReason, ...cap.strengths.slice(0, 1), ...need.risks.slice(0, 1)], "What new evidence would make this company a realistic sprint client", 0);
  }

  if (!i.screened) {
    return make("investigate_website", "Nothing is known yet about the site experience or current business priorities, so a quick screen is the cheapest way to learn whether it deserves attention.", "Run the standard screening on the homepage and key pages before any deeper research.", [...cap.strengths, buyer.line], "Whether the site shows any business trigger or experience problem at all");
  }

  if (!capacityEstablished) {
    const activity = [...cap.strengths, ...cap.risks, ...triggers.slice(0, 2)];
    const sizeNote = access.strengths.find((s) => s.startsWith("Small reported team")) ?? access.risks.find((s) => s.startsWith("Larger organisation"));
    return make(
      "verify_commercial_capacity",
      `${activity.length ? "There is commercial activity" : "Little commercial evidence exists"}, but nothing yet shows the company can fund a $4,500 sprint. ${buyer.state === "none" ? "No buyer is identified either, so" : "Even with a possible buyer,"} capacity is the question that decides whether more effort is worthwhile.`,
      "Lightweight check only: look for a revenue estimate, funding, retail or wholesale footprint, or press coverage. Avoid deeper research until capacity looks plausible.",
      [...activity, ...(sizeNote ? [sizeNote] : []), buyer.line],
      cap.unknowns[0] ?? "Annual revenue or funding: whether the company can fund a $4,500 sprint",
    );
  }

  const capacityLines = cap.strengths.length ? cap.strengths : cap.risks;
  if (shown(need.level) && buyer.state !== "confirmed") {
    return make(
      "confirm_decision_maker",
      `The company can likely pay and shows a need for outside help, so the opportunity is meaningful. ${buyer.state === "possible" ? "The likely buyer is not confirmed" : "Nobody with authority to hire a consultant is identified"}, which is now the main gap.`,
      "Confirm from a public source (company site, LinkedIn, press) who owns ecommerce or growth and that they are in the role today.",
      [...need.strengths.slice(0, 2), ...capacityLines.slice(0, 1), buyer.line],
      buyer.state === "possible" ? `${buyer.line.replace("Possible decision-maker, not confirmed: ", "")}: current role and budget authority unconfirmed` : "Who owns ecommerce or growth and can approve a $4,500 sprint",
    );
  }

  if (hyp.length) {
    return make(
      "investigate_website",
      `${i.fitStatus === "probable_fit" || i.fitStatus === "verified_fit" ? "Fit and capacity are credible and there" : "Fit is still being qualified, but there"} is a specific, sourced hypothesis to test: ${hyp[0].title}. A targeted look at the pages involved will show whether it is a real problem worth outside help.`,
      `Targeted review of the pages behind "${hyp[0].title}"; capture evidence that confirms or rules it out.`,
      [...hyp.slice(0, 2).map((s) => `Hypothesis: ${s.title} (${s.confidence} confidence)`), ...capacityLines.slice(0, 1), buyer.line],
      hyp[0].criticalUnknowns[0] ?? `Whether "${hyp[0].title}" actually hurts visitors or conversion`,
    );
  }

  if (shown(need.level)) {
    return make("investigate_website", "Capacity, need and a confirmed buyer are in place; the remaining value is in specific site evidence to shape the sprint.", "Request deeper site research on the highest-traffic journeys.", [...need.strengths.slice(0, 2), ...capacityLines.slice(0, 1), buyer.line], need.unknowns[0] ?? "Which specific journeys would gain most from the sprint");
  }

  return make(
    "validate_business_need",
    `The company looks commercially established${buyer.state === "none" ? "" : " and has a plausible buyer"}, but no specific conversion or experience problem has been shown. Whether they actually need outside help is the question that decides the opportunity.`,
    "Review the home, collection, product and cart pages for a specific, observable conversion or experience problem before any deeper research.",
    [...capacityLines.slice(0, 2), buyer.line, ...need.risks.slice(0, 1), ...triggers.slice(0, 1)],
    need.risks[0] ? `${need.risks[0]}; whether there is still a problem worth outside help` : need.unknowns.find((u) => !u.startsWith("Observed on the site")) ?? "Whether the site has a problem worth outside help",
  );
}
