import type { EvidencePack, PackImage, PageView } from "./evidence.ts";
import type { Finding, VerifierOutput } from "./schemas.ts";
import type { Claim } from "./claims.ts";
import { captureStateWordingCheck, factLinksCheck, overlayKindsSeparateCheck, pageAttributionCheck, pageScopeCheck, sharedImageIdentityCheck } from "./structureChecks.ts";
import { isScreenshotQuote, quoteSegments } from "./quotes.ts";

/** blocker: rejects. revision: needs revision at best. warning and info: shown to reviewers only. */
export type CheckSeverity = "blocker" | "revision" | "warning" | "info";

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
const MEASUREMENT_FIELDS = new Set(["measurement_plan", "validation_data_needed", "intent_signals_to_examine", "unknowns", "critical_unknowns"]);

const OUTCOME_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "a stated rate", re: /\b(conversion|abandon\w*|bounce|drop[- ]?off|exit|churn|retention|click[- ]?through|add[- ]to[- ](?:cart|bag))\s+rates?\b[^.;]{0,30}?\b(?:is|are|was|of|at|around|about|near|~)\s*\d/i },
  { label: "a share of visitors", re: /\b\d+(?:\.\d+)?\s?%\s+(?:of\s+)?(?:visitors|users|shoppers|sessions|customers|buyers|people|traffic|mobile|desktop|carts?|orders)\b/i },
  { label: "a projected change", re: /\b(?:lift|uplift|increas\w*|boost\w*|improv\w*|reduc\w*|decreas\w*|grow\w*|gain\w*|rais\w*|cut\w*|recover\w*)\b[^.;]{0,40}?(?:\d+(?:\.\d+)?\s?%|\$\s?\d[\d,.]*|\d+(?:\.\d+)?x\b)/i },
  { label: "a revenue figure", re: /\$\s?\d[\d,.]*\s?(?:k|m|million|thousand|bn)?\s+(?:in\s+)?(?:revenue|sales|per\s+(?:month|year)|annually|lost|missed|left)/i },
  { label: "a test result", re: /\b(?:tests?|experiments?|a\/b)\b[^.;]{0,40}\b(?:showed|proved|found|delivered|won|resulted)\b/i },
];
const FRAMING = /\b(measure|investigate|examine|validate|verify|check|whether|what share|how many|how much|unknown|track|compare|baseline|segment by|look at|quantify|estimate from)\b/i;

const NON_PROSE = new Set([
  "finding_ref",
  "page_type",
  "confidence",
  "evidence_quality",
  "fact_id",
  "evidence_refs",
  "region",
  "text_excerpt",
  "quote_kind",
  "page_ref",
  "device",
  "finding_class",
  "problem_type",
  "inference_id",
  "basis_fact_ids",
  "fact_ids",
  "severity",
  "resolution_source",
  "resolution_effort",
  "levers",
  "level",
  "confirming_evidence",
]);

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
  const undeclared: string[] = [];
  let pageTextQuotes = 0;
  let screenshotQuotes = 0;
  for (const fact of f.observed_facts) {
    const segments = quoteSegments(fact);
    if (!segments.length) continue;
    if (!fact.quote_kind) {
      undeclared.push(fact.fact_id);
      continue;
    }
    const ownPage = fact.evidence_refs.map((ref) => cited.get(ref)).filter((r): r is ResolvedRef => !!r && r.page.ref === fact.page_ref);
    if (isScreenshotQuote(fact)) {
      if (!ownPage.some((r) => r.image)) quoteProblems.push(`${fact.fact_id}: quote is declared as screenshot wording but cites no screenshot of ${fact.page_ref}`);
      else screenshotQuotes++;
      continue;
    }
    const texts = ownPage.filter((r) => !r.image);
    if (!texts.length) {
      quoteProblems.push(`${fact.fact_id}: quote is declared as page text but cites no page text of ${fact.page_ref}`);
      continue;
    }
    const missingSegments = segments.filter((s) => !texts.some((r) => normalise(r.page.fullText).includes(normalise(s))));
    if (missingSegments.length) {
      quoteProblems.push(`${fact.fact_id}: ${missingSegments.map((s) => `"${s.slice(0, 80)}"`).join(", ")} not found in ${texts.map((r) => r.ref).join(", ")}`);
    } else pageTextQuotes++;
  }
  checks.push({
    check: "quotes_match_page_text",
    passed: !quoteProblems.length,
    severity: quoteProblems.length ? "blocker" : "info",
    detail: quoteProblems.length
      ? quoteProblems.join("; ")
      : `${pageTextQuotes} page-text quote(s) found in stored page text; ${screenshotQuotes} screenshot quote(s) sent to the verifier to read in the cited screenshots`,
  });
  checks.push({
    check: "quote_source_declared",
    passed: !undeclared.length,
    severity: undeclared.length ? "revision" : "info",
    detail: undeclared.length
      ? `${undeclared.join(", ")} quote wording without saying whether it comes from page text or a screenshot, or whether it is one passage or separate labels`
      : "Every quote declares its source and form",
  });

  checks.push(
    pageAttributionCheck(f, pack),
    sharedImageIdentityCheck(f, pack),
    pageScopeCheck(f, pack),
    captureStateWordingCheck(f, pack),
    overlayKindsSeparateCheck(f),
    factLinksCheck(f),
  );

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

  const citedPages = [
    ...new Map([
      ...[...cited.values()].map((r) => [r.page.ref, r.page] as const),
      ...f.observed_facts.flatMap((x) => pack.pages.filter((p) => p.ref === x.page_ref).map((p) => [p.ref, p] as const)),
    ]).values(),
  ];
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
  for (const c of checks.filter((x) => !x.passed && x.severity === "revision")) {
    status = worst(status, "needs_revision");
    reasons.push(`Automatic check needs revision (${c.check}): ${c.detail}`);
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
  status = worst(worst(status, verdict.evidence_verdict), verdict.overall);
  reasons.push(`Verifier: ${verdict.overall_reason}`);
  return { status, reason: reasons.join(" ") };
}

/** Factual standing only: automatic checks, observed facts, inferences, page and capture state. Commercial value is ignored. */
export function evidenceStatus(checks: AutomaticCheck[], claims: Claim[], verdict: VerifierOutput | null): VerificationStatus {
  let status: VerificationStatus = "supported";
  if (hasBlocker(checks)) status = "rejected";
  if (checks.some((c) => !c.passed && c.severity === "revision")) status = worst(status, "needs_revision");
  if (!verdict) return status;
  const typeOf = new Map(claims.map((c) => [c.id, c.type]));
  for (const cc of verdict.claim_checks) {
    const type = typeOf.get(cc.claim_id);
    if (type === "observed_fact" && (cc.verdict === "not_demonstrated" || cc.verdict === "contradicted")) status = "rejected";
    else if ((type === "observed_fact" || type === "behavioral_inference") && cc.verdict !== "demonstrated" && cc.verdict !== "appropriately_framed") status = worst(status, "needs_revision");
  }
  if (!verdict.page_and_state_check.correct) status = worst(status, "needs_revision");
  return worst(status, verdict.evidence_verdict);
}
