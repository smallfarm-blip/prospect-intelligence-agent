import type { Signal } from "./types.ts";

/**
 * What a screening signal actually shows. Only an experience problem or a capability gap is evidence of need;
 * commercial triggers speak to business context, facts and hypotheses are things to investigate.
 */
export type EvidenceKind = "commercial_trigger" | "capability_gap" | "experience_problem" | "experience_fact" | "friction_hypothesis";

const BUSINESS_TYPES = new Set(["business_trigger", "growth_initiative", "organizational_change"]);

const SERVICE_AREA = /e-?commerce|digital|online store|web ?site|storefront|\bcro\b|conversion|\bux\b|user experience|experimentation|a\/b test|optimi[sz]ation|personali[sz]|merchandis/i;
const CAPABILITY_GAP = /no (dedicated|in-house|internal)|lacks?\b|without an? (dedicated|in-house)|departed|left the company|stepped down|vacant|seeking an? (agency|partner|consultant)|request for proposals?|\brfp\b|outsourc|one-person|sole (marketer|employee)/i;
const SERVICE_LINK = /re-?platform|migrat\w* (to|from|onto)|headless|(web ?site|site|storefront|online store) (redesign|relaunch|rebuild|migration)|redesign\w* (its|the|their) (web ?site|site|storefront)|new (web ?site|storefront|online store)|checkout|conversion rate|\bcro\b|\bux\b|user experience|personali[sz]|a\/b test|experimentation|(head|director|vp|manager|lead) of (e-?commerce|digital|growth)|(e-?commerce|digital|growth) (director|manager|lead)/i;
const VISIBLE_PROBLEM = /sold[ -]?out|out of stock|unavailable|broken|\berrors?\b|\b404\b|fails? to|does not load|not loading|slow(ly)? to load|loads? slowly|missing|no (search|filter|reviews|size)|hard to|difficult|confus|conflict|contradict|overlap|inconsistent|expired|block(s|ing|ed)|covers? (the )?(content|page|product)|interrupt|dead[- ]end|empty (page|results|collection)/i;
const PROMO_CONFLICT = /conflict|contradict|overlap|expired|broken|\berrors?\b|block(s|ing|ed)|covers? (the )?(content|page|product)|fails? to apply/i;

const observed = (s: Signal) => `${s.title} ${s.observedEvidence}`;

/** Sourced, high confidence, with an observation and an explained relevance. */
export function isStrongSignal(s: Signal): boolean {
  return s.confidence === "high" && s.sourceUrls.length > 0 && s.observedEvidence.trim().length >= 20 && s.businessRelevance.trim().length >= 20;
}

const supported = (s: Signal) => s.confidence !== "low" && s.sourceUrls.length > 0 && s.observedEvidence.trim().length >= 20;

export const isBusinessSignal = (s: Signal) => BUSINESS_TYPES.has(s.signalType);

/** Judged on what was observed, never on the screening model's interpretation of it. */
export function classifySignal(s: Signal): EvidenceKind {
  const text = observed(s);
  if (isBusinessSignal(s)) return supported(s) && SERVICE_AREA.test(text) && CAPABILITY_GAP.test(text) ? "capability_gap" : "commercial_trigger";
  if (s.signalType === "promotional_orchestration") return supported(s) && PROMO_CONFLICT.test(text) ? "experience_problem" : "friction_hypothesis";
  if (!supported(s)) return "friction_hypothesis";
  return VISIBLE_PROBLEM.test(text) ? "experience_problem" : "experience_fact";
}

/** A trigger whose observed evidence ties directly to conversion, UX, experimentation or personalisation work. */
export function isServiceLinked(s: Signal): boolean {
  return SERVICE_LINK.test(observed(s));
}

export function byKind(signals: Signal[]): Record<EvidenceKind, Signal[]> {
  const out: Record<EvidenceKind, Signal[]> = { commercial_trigger: [], capability_gap: [], experience_problem: [], experience_fact: [], friction_hypothesis: [] };
  for (const s of signals) out[classifySignal(s)].push(s);
  return out;
}
