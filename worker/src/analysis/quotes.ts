import type { Finding } from "./schemas.ts";

type Fact = Finding["observed_facts"][number];

export const isScreenshotQuote = (fact: Fact) => fact.quote_kind === "screenshot_verbatim" || fact.quote_kind === "screenshot_labels";

/** The pieces of a quote that must each appear verbatim: the whole passage, or each label of a label set. */
export function quoteSegments(fact: Fact): string[] {
  const excerpt = fact.text_excerpt?.trim();
  if (!excerpt) return [];
  if (fact.quote_kind === "page_text_labels" || fact.quote_kind === "screenshot_labels") {
    return excerpt.split(/\s*[|;]\s*/).filter(Boolean);
  }
  return [excerpt];
}
