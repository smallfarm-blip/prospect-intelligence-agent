import type { EvidencePack, PackImage, PageView } from "./evidence.ts";
import type { Finding, VerifierOutput } from "./schemas.ts";
import type { Claim } from "./claims.ts";

export type CheckSeverity = "blocker" | "warning" | "info";

export interface AutomaticCheck {
  check: string;
  passed: boolean;
  severity: CheckSeverity;
  detail: string;
}

export type VerificationStatus = "supported" | "needs_revision" | "rejected";

export interface ResolvedRef {
  ref: string;
  page: PageView;
  image: PackImage | null;
}

export function resolveRef(pack: EvidencePack, ref: string): ResolvedRef | null {
  if (ref.startsWith("IMG-")) {
    const image = pack.images.find((i) => i.ref === ref);
    const page = image && pack.pages.find((p) => p.ref === image.pageRef);
    return image && page ? { ref, page, image } : null;
  }
  const page = pack.pages.find((p) => p.textRef === ref);
  return page ? { ref, page, image: null } : null;
}

const normalise = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/** Fields where numbers are expected because they describe data to collect, not outcomes. */
const MEASUREMENT_FIELDS = new Set(["measurement_plan", "validation_data_needed", "intent_signals_to_examine", "unknowns"]);

const OUTCOME_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "a stated rate", re: /\b(conversion|abandon\w*|bounce|drop[- ]?off|exit|churn|retention|click[- ]?through|add[- ]to[- ](?:cart|bag))\s+rates?\b[^.;]{0,30}?\b(?:is|are|was|of|at|around|about|near|~)\s*\d/i },
  { label: "a share of visitors", re: /\b\d+(?:\.\d+)?\s?%\s+(?:of\s+)?(?:visitors|users|shoppers|sessions|customers|buyers|people|traffic|mobile|desktop|carts?|orders)\b/i },
  { label: "a projected change", re: /\b(?:lift|uplift|increas\w*|boost\w*|improv\w*|reduc\w*|decreas\w*|grow\w*|gain\w*|rais\w*|cut\w*|recover\w*)\b[^.;]{0,40}?(?:\d+(?:\.\d+)?\s?%|\$\s?\d[\d,.]*|\d+(?:\.\d+)?x\b)/i },
  { label: "a revenue figure", re: /\$\s?\d[\d,.]*\s?(?:k|m|million|thousand|bn)?\s+(?:in\s+)?(?:revenue|sales|per\s+(?:month|year)|annually|lost|missed|left)/i },
  { label: "a test result", re: /\b(?:tests?|experiments?|a\/b)\b[^.;]{0,40}\b(?:showed|proved|found|delivered|won|resulted)\b/i },
];
const FRAMING = /\b(measure|investigate|examine|validate|verify|check|whether|what share|how many|how much|unknown|track|compare|baseline|segment by|look at|quantify|estimate from)\b/i;

const NON_PROSE = new Set(["finding_ref", "page_type", "confidence", "evidence_quality", "fact_id", "evidence_refs", "region", "text_excerpt"]);

/** Prose written by the analyst, labelled by top-level field. Quotes of page text are excluded. */
function textFields(f: Finding): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const walk = (field: string, v: unknown) => {
    if (typeof v === "string") out.push({ field, text: v });
    else if (Array.isArray(v)) v.forEach((x) => walk(field, x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!NON_PROSE.has(k)) walk(field, x);
  };
  for (const [k, v] of Object.entries(f)) if (!NON_PROSE.has(k)) walk(k, v);
  return out;
}

/** A figure that appears verbatim in stored page text is the site's own wording, not an invented outcome. */
function figureFromPage(match: string, pack: EvidencePack): boolean {
  const figures = match.match(/\$?\s?\d[\d,.]*\s?(?:%|x\b)?/g) ?? [];
  return figures.length > 0 && figures.every((fig) => pack.pages.some((p) => normalise(p.fullText).includes(normalise(fig))));
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/);
}

const COOKIE_REMOVED = [
  /\b(?:cookie|consent)\b[^.;]{0,60}\b(?:dismissed|removed|closed|cleared|declined|gone|no longer (?:visible|shown|present))\b/i,
  /\b(?:dismissed|removed|closed|cleared|declined|dismissing|removing|closing|declining)\b[^.;]{0,40}\b(?:cookie|consent)\b/i,
  /\bno (?:cookie|consent) (?:banner|notice|prompt|bar)\b/i,
];

export function automaticChecks(f: Finding, pack: EvidencePack): AutomaticCheck[] {
  const checks: AutomaticCheck[] = [];
  const cited = new Map<string, ResolvedRef>();

  const missing: string[] = [];
  for (const fact of f.observed_facts) {
    for (const ref of fact.evidence_refs) {
      const r = resolveRef(pack, ref);
      if (r) cited.set(ref, r);
      else missing.push(`${fact.fact_id} cites ${ref}`);
    }
  }
  checks.push({
    check: "evidence_references_exist",
    passed: !missing.length,
    severity: missing.length ? "blocker" : "info",
    detail: missing.length ? `References not in this analysis: ${missing.join("; ")}` : `All ${cited.size} cited references exist`,
  });

  const regionProblems: string[] = [];
  for (const fact of f.observed_facts) {
    const r = fact.region;
    if (!r) continue;
    if (!resolveRef(pack, r.image_ref)) regionProblems.push(`${fact.fact_id}: region image ${r.image_ref} does not exist`);
    else if (!fact.evidence_refs.includes(r.image_ref)) regionProblems.push(`${fact.fact_id}: region image ${r.image_ref} is not among its cited references`);
    if (r.x + r.width > 1.001 || r.y + r.height > 1.001) regionProblems.push(`${fact.fact_id}: region extends beyond the image`);
  }
  checks.push({
    check: "regions_valid",
    passed: !regionProblems.length,
    severity: regionProblems.length ? "warning" : "info",
    detail: regionProblems.length ? regionProblems.join("; ") : "Regions are inside their images",
  });

  const quoteProblems: string[] = [];
  let visualOnly = 0;
  for (const fact of f.observed_facts) {
    if (!fact.text_excerpt?.trim()) continue;
    const textPages = fact.evidence_refs.map((ref) => cited.get(ref)).filter((r): r is ResolvedRef => !!r && !r.image);
    if (!textPages.length) {
      visualOnly++;
      continue;
    }
    const quote = normalise(fact.text_excerpt);
    if (!textPages.some((r) => normalise(r.page.fullText).includes(quote))) {
      quoteProblems.push(`${fact.fact_id}: "${fact.text_excerpt.slice(0, 80)}" not found in ${textPages.map((r) => r.ref).join(", ")}`);
    }
  }
  checks.push({
    check: "quotes_match_page_text",
    passed: !quoteProblems.length,
    severity: quoteProblems.length ? "blocker" : "info",
    detail: quoteProblems.length
      ? quoteProblems.join("; ")
      : `Quoted text found in stored page text${visualOnly ? `; ${visualOnly} quote(s) cite only screenshots and are left to the verifier` : ""}`,
  });

  if (f.page_type !== "cross_page") {
    const other = [...cited.values()].filter((r) => r.page.pageType !== f.page_type).map((r) => `${r.ref} is ${r.page.pageType}`);
    checks.push({
      check: "page_type_matches",
      passed: !other.length,
      severity: other.length ? "warning" : "info",
      detail: other.length ? `Finding is about ${f.page_type} but ${[...new Set(other)].join(", ")}` : `All evidence is from ${f.page_type} pages`,
    });
  }

  const overlayFacts = f.observed_facts.filter((x) => /\b(overlay|pop-?up|modal|banner|cookie|consent|interstitial)\b/i.test(x.statement));
  const afterOnly = overlayFacts.filter((x) => {
    const refs = x.evidence_refs.map((ref) => cited.get(ref)).filter((r): r is ResolvedRef => !!r?.image);
    return refs.length && refs.every((r) => r.image!.captureState !== "initial_viewport");
  });
  if (overlayFacts.length) {
    checks.push({
      check: "overlay_claims_cite_initial_state",
      passed: !afterOnly.length,
      severity: afterOnly.length ? "warning" : "info",
      detail: afterOnly.length
        ? `${afterOnly.map((x) => x.fact_id).join(", ")} describe overlays but cite no initial-viewport screenshot`
        : "Overlay observations cite the initial state",
    });
  }

  const unframed: string[] = [];
  for (const { field, text } of textFields(f)) {
    if (MEASUREMENT_FIELDS.has(field)) continue;
    for (const s of sentences(text)) {
      for (const p of OUTCOME_PATTERNS) {
        const m = s.match(p.re);
        if (!m || FRAMING.test(s)) continue;
        if (field === "observed_facts" && figureFromPage(m[0], pack)) continue;
        unframed.push(`${field}: ${p.label} in "${s.slice(0, 120)}"`);
      }
    }
  }
  checks.push({
    check: "no_invented_figures",
    passed: !unframed.length,
    severity: unframed.length ? "blocker" : "info",
    detail: unframed.length
      ? `Figures or outcomes stated as fact rather than as data to investigate: ${unframed.join("; ")}`
      : "No conversion rates, lift, revenue or test results asserted",
  });

  const citedPages = [...new Map([...cited.values()].map((r) => [r.page.ref, r.page])).values()];
  const metadataNotes: string[] = [];
  const contradictions: string[] = [];
  const claimsCookieGone = textFields(f)
    .flatMap((t) => sentences(t.text))
    .some((s) => COOKIE_REMOVED.some((re) => re.test(s)) && !/\b(not|never|remain\w*|still|persist\w*|without|whether|if)\b|n't\b/i.test(s));
  for (const page of citedPages) {
    const o = page.overlays;
    const consentRemoved = o.removed.some((x) => x.kind === "consent");
    if (o.legacyFormat && o.status === "all_dismissed" && !consentRemoved) {
      metadataNotes.push(
        `${page.ref}: overlay record says all_dismissed but uses the earlier format and lists only ${o.removed.map((x) => x.kind).join(", ") || "no"} overlay(s) as closed; a cookie banner may still be visible`,
      );
    }
    if (!consentRemoved && claimsCookieGone) {
      contradictions.push(`Finding says a cookie/consent banner was dismissed or absent on ${page.ref}, but no record shows a consent banner being closed there`);
    }
  }
  checks.push({
    check: "overlay_metadata_consistency",
    passed: !contradictions.length,
    severity: contradictions.length ? "blocker" : metadataNotes.length ? "warning" : "info",
    detail: [...contradictions, ...metadataNotes].join("; ") || "No overlay record caveats for cited pages",
  });

  return checks;
}

const RANK: Record<VerificationStatus, number> = { supported: 0, needs_revision: 1, rejected: 2 };
const worst = (a: VerificationStatus, b: VerificationStatus) => (RANK[a] >= RANK[b] ? a : b);

export function hasBlocker(checks: AutomaticCheck[]): boolean {
  return checks.some((c) => !c.passed && c.severity === "blocker");
}

/** Final status: the strictest of the automatic checks, the claim verdicts and the verifier's overall call. */
export function combineVerdict(
  checks: AutomaticCheck[],
  claims: Claim[],
  verdict: VerifierOutput | null,
): { status: VerificationStatus; reason: string } {
  const reasons: string[] = [];
  let status: VerificationStatus = "supported";
  for (const c of checks.filter((x) => !x.passed && x.severity === "blocker")) {
    status = "rejected";
    reasons.push(`Automatic check failed (${c.check}): ${c.detail}`);
  }
  if (!verdict) {
    return { status, reason: reasons.join(" ") || "Not verified by a model" };
  }
  const typeOf = new Map(claims.map((c) => [c.id, c.type]));
  for (const cc of verdict.claim_checks) {
    const type = typeOf.get(cc.claim_id);
    if (!type) continue;
    if (type === "observed_fact" && (cc.verdict === "not_demonstrated" || cc.verdict === "contradicted")) {
      status = "rejected";
      reasons.push(`${cc.claim_id} (observed fact) ${cc.verdict.replace("_", " ")}: ${cc.reason}`);
    } else if (cc.verdict === "partially_demonstrated" || cc.verdict === "overstated") {
      status = worst(status, "needs_revision");
      reasons.push(`${cc.claim_id} (${type.replace("_", " ")}) ${cc.verdict.replace("_", " ")}: ${cc.reason}`);
    }
  }
  if (verdict.generic_check.generic) {
    status = "rejected";
    reasons.push(`Generic: ${verdict.generic_check.reason}`);
  }
  if (!verdict.decision_problem.meaningful) {
    status = "rejected";
    reasons.push(`Not a meaningful visitor decision problem: ${verdict.decision_problem.reason}`);
  }
  if (!verdict.page_and_state_check.correct) {
    status = worst(status, "needs_revision");
    reasons.push(`Page or capture state: ${verdict.page_and_state_check.reason}`);
  }
  status = worst(status, verdict.overall);
  reasons.push(`Verifier: ${verdict.overall_reason}`);
  return { status, reason: reasons.join(" ") };
}
