import type { EvidencePack } from "./evidence.ts";
import { imagePages } from "./evidence.ts";
import { CAPTURE_STATE_TERMS } from "./captureStates.ts";
import type { Finding } from "./schemas.ts";
import type { AutomaticCheck } from "./checks.ts";

const result = (check: string, problems: string[], failSeverity: AutomaticCheck["severity"], okDetail: string): AutomaticCheck => ({
  check,
  passed: !problems.length,
  severity: problems.length ? failSeverity : "info",
  detail: problems.length ? problems.join("; ") : okDetail,
});

/** Each cited reference must belong to the page the fact names, on the device it names. */
export function pageAttributionCheck(f: Finding, pack: EvidencePack): AutomaticCheck {
  const problems: string[] = [];
  for (const fact of f.observed_facts) {
    const page = pack.pages.find((p) => p.ref === fact.page_ref);
    if (!page) {
      problems.push(`${fact.fact_id} names page ${fact.page_ref}, which is not in this analysis`);
      continue;
    }
    if (page.viewport !== fact.device) problems.push(`${fact.fact_id} says ${fact.device} but ${page.ref} was captured on ${page.viewport}`);
    for (const ref of fact.evidence_refs) {
      const img = pack.images.find((i) => i.ref === ref);
      if (img && !imagePages(img).includes(page.ref)) problems.push(`${fact.fact_id} attributes ${ref} to ${page.ref}, but it was captured for ${imagePages(img).join(", ")}`);
      const textPage = !img && pack.pages.find((p) => p.textRef === ref);
      if (textPage && textPage.ref !== page.ref) problems.push(`${fact.fact_id} is about ${page.ref} but cites ${ref} from ${textPage.ref}`);
    }
  }
  return result("page_attribution", problems, "blocker", "Every cited image and text belongs to the page and device each fact names");
}

/** A byte-identical image shared by several pages cannot prove which page a fact is about on its own. */
export function sharedImageIdentityCheck(f: Finding, pack: EvidencePack): AutomaticCheck {
  const problems: string[] = [];
  let shared = 0;
  for (const fact of f.observed_facts) {
    const images = fact.evidence_refs.map((ref) => pack.images.find((i) => i.ref === ref)).filter((i) => !!i);
    const sharedHere = images.filter((i) => i.alsoShownFor.length && imagePages(i).includes(fact.page_ref));
    if (!sharedHere.length) continue;
    shared++;
    const page = pack.pages.find((p) => p.ref === fact.page_ref);
    const identifies = fact.evidence_refs.some((ref) => ref === page?.textRef) || images.some((i) => !i.alsoShownFor.length && imagePages(i).includes(fact.page_ref));
    if (!identifies) {
      problems.push(
        `${fact.fact_id} relies on ${sharedHere.map((i) => i.ref).join(", ")}, which is identical across ${[...new Set(sharedHere.flatMap(imagePages))].join(", ")}; cite ${page?.textRef ?? "page text"} or another ${fact.page_ref} image to establish which page it is`,
      );
    }
  }
  return result(
    "shared_image_page_identity",
    problems,
    "revision",
    shared ? "Facts citing shared images also cite evidence that identifies their page" : "No fact relies on an image shared between pages",
  );
}

const FIRST_LOAD_WORDS = /\b(initial(?:ly)?|first[- ]visit|first[- ]load|on (?:first )?load|as served|before any interaction|first screen|above the fold)\b/i;
const CLEAR_VIEW_WORDS = /\b(after (?:closing|dismiss\w*)|first clear view|once (?:the )?(?:pop-?ups?|overlays?|banners?) (?:is|are|was|were|had been|have been) (?:closed|dismissed))\b/i;

/** The words used for a capture state must match the state of the screenshots cited. */
export function captureStateWordingCheck(f: Finding, pack: EvidencePack): AutomaticCheck {
  const problems: string[] = [];
  for (const fact of f.observed_facts) {
    const states = fact.evidence_refs.map((ref) => pack.images.find((i) => i.ref === ref)?.captureState).filter((s) => !!s);
    if (!states.length) continue;
    if (FIRST_LOAD_WORDS.test(fact.statement) && !states.includes("initial_viewport")) {
      problems.push(`${fact.fact_id} describes the first load but cites only ${[...new Set(states)].map((s) => `"${CAPTURE_STATE_TERMS[s].label}"`).join(", ")} screenshots`);
    }
    if (CLEAR_VIEW_WORDS.test(fact.statement) && states.every((s) => s === "initial_viewport")) {
      problems.push(`${fact.fact_id} describes the view after closing pop-ups but cites only "${CAPTURE_STATE_TERMS.initial_viewport.label}" screenshots`);
    }
  }
  return result("capture_state_wording", problems, "revision", "Capture-state wording matches the screenshots cited");
}

const CONSENT_WORDS = /\b(cookie|consent)\b/i;
const PROMO_WORDS = /\b(promo\w*|discount|\d+\s?% off|offer|newsletter|sign[- ]?up|takeover|email capture)\b/i;

export function overlayKindsSeparateCheck(f: Finding): AutomaticCheck {
  const merged = f.observed_facts.filter((x) => CONSENT_WORDS.test(x.statement) && PROMO_WORDS.test(x.statement)).map((x) => x.fact_id);
  return result(
    "consent_and_promotion_separate",
    merged.length ? [`${merged.join(", ")} describe a cookie consent banner and a promotional pop-up in one fact; record them as separate facts`] : [],
    "revision",
    "Cookie consent and promotional overlays are recorded as separate facts",
  );
}

/** Inferences, existing-support entries and journey steps must point at facts that exist. */
export function factLinksCheck(f: Finding): AutomaticCheck {
  const facts = new Map(f.observed_facts.map((x) => [x.fact_id, x]));
  const problems: string[] = [];
  for (const inf of f.behavioral_inferences) {
    const missing = inf.basis_fact_ids.filter((id) => !facts.has(id));
    if (missing.length) problems.push(`${inf.inference_id} rests on ${missing.join(", ")}, which are not observed facts in this finding`);
  }
  for (const s of f.existing_site_support) {
    const missing = s.fact_ids.filter((id) => !facts.has(id));
    if (missing.length) problems.push(`Existing support "${s.support.slice(0, 60)}" cites missing fact(s) ${missing.join(", ")}`);
  }
  return result("fact_links_valid", problems, "revision", "Inferences and existing-support entries rest on observed facts in this finding");
}

/** Evidence from several pages needs a journey; a single-page finding should cite only its page type. */
export function pageScopeCheck(f: Finding, pack: EvidencePack): AutomaticCheck {
  const problems: string[] = [];
  const factPages = [...new Set(f.observed_facts.map((x) => x.page_ref))];
  const pages = factPages.map((ref) => pack.pages.find((p) => p.ref === ref)).filter((p) => !!p);
  if (f.journey) {
    const steps = f.journey.steps;
    const stepPages = new Set(steps.map((s) => s.page_ref));
    for (const s of steps) {
      if (!pack.pages.some((p) => p.ref === s.page_ref)) problems.push(`Journey step ${s.page_ref} is not a page in this analysis`);
      for (const id of s.fact_ids) {
        const fact = f.observed_facts.find((x) => x.fact_id === id);
        if (!fact) problems.push(`Journey step ${s.page_ref} cites missing fact ${id}`);
        else if (fact.page_ref !== s.page_ref) problems.push(`Journey step ${s.page_ref} cites ${id}, which is about ${fact.page_ref}`);
      }
    }
    for (const ref of factPages) if (!stepPages.has(ref)) problems.push(`Facts about ${ref} are not part of the journey`);
    return result("page_scope", problems, "revision", `Cross-page evidence forms a ${steps.length}-step journey with evidence for every step`);
  }
  if (f.page_type === "cross_page") {
    problems.push("A cross-page finding needs a journey that ties each page's evidence to a step");
  } else {
    const other = pages.filter((p) => p.pageType !== f.page_type).map((p) => `${p.ref} is ${p.pageType}`);
    if (other.length) problems.push(`Finding is about a ${f.page_type} but ${other.join(", ")}; add a journey or keep to ${f.page_type} evidence`);
  }
  return result("page_scope", problems, "revision", `All facts are about ${f.page_type} pages`);
}
