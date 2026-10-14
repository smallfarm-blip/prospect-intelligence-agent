import { canonicalizeUrl, isSameSite } from "./url.ts";

export interface PageLink {
  href: string;
  text: string;
  inNav: boolean;
}

export type LinkKind = "pdp" | "plp" | "other";

const EXCLUDED_PATH = /\/(account|cart|checkout|login|register|search|pages|blogs?|policies|help|faq|contact|about|stores?|gift-?cards?|wishlist|rewards|returns)(\/|$)/i;
const PDP_PATH = /(\/products?\/[^/]+$)|(\/p\/[^/]+$)|(\/dp\/[^/]+)|(-p-\d+(\.html)?$)/i;
const PLP_PATH = /(\/collections\/[^/]+$)|(\/(category|categories|c)\/[^/]+)|(\/shop\/[^/]+$)|(\/shop-all$)|(\/(womens?|mens?|kids|new-arrivals|bestsellers?|best-sellers)$)/i;
const NON_MERCH_COLLECTION = /\/collections\/(frontpage|all-gift-cards?|gift-cards?|vendors|types)$/i;

export function classifyLink(url: string): LinkKind {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "other";
  }
  if (EXCLUDED_PATH.test(path)) return "other";
  if (PDP_PATH.test(path)) return /gift-?card/i.test(path) ? "other" : "pdp";
  if (PLP_PATH.test(path) && !NON_MERCH_COLLECTION.test(path)) return "plp";
  return "other";
}

function uniqueSameSite(links: PageLink[], domain: string, kind: LinkKind): PageLink[] {
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const link of links) {
    if (!isSameSite(link.href, domain) || classifyLink(link.href) !== kind) continue;
    const canonical = canonicalizeUrl(link.href);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ ...link, href: canonical });
  }
  return out;
}

/** Ranks category/collection links; navigation links and broad "shop all" style labels rank first. */
export function rankPlpCandidates(links: PageLink[], domain: string, limit: number): PageLink[] {
  const scored = uniqueSameSite(links, domain, "plp").map((link, order) => {
    let score = 0;
    if (link.inNav) score += 3;
    if (/\b(shop all|all|new|best|bestsellers?|women|men)\b/i.test(link.text)) score += 1;
    if (/sale|clearance|outlet/i.test(link.href + link.text)) score -= 1;
    return { link, score, order };
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.link);
}

export function productLinks(links: PageLink[], domain: string): PageLink[] {
  return uniqueSameSite(links, domain, "pdp");
}

/**
 * Picks two products far apart in listing order. Positional spread is a proxy for
 * contrast only; it does not verify that the products actually differ.
 */
export function pickContrastingPdps(products: PageLink[]): PageLink[] {
  if (products.length <= 2) return products.slice(0, 2);
  const second = products[Math.max(1, Math.floor((products.length * 2) / 3))];
  return [products[0], second];
}
