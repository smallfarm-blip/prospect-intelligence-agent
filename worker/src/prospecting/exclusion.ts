import type { CompanyEntity } from "./types.ts";

export interface Exclusion {
  rule: string;
  reason: string;
}

/** Domains that are never a candidate company: marketplaces, big retailers, social, media and data sites. */
const NOT_A_CANDIDATE: Record<string, string> = Object.fromEntries(
  [
    ["marketplace or large retailer", "amazon.com etsy.com ebay.com walmart.com target.com faire.com zappos.com nordstrom.com sephora.com ulta.com macys.com wayfair.com costco.com bestbuy.com kohls.com revolve.com ssense.com"],
    ["social network or video platform", "linkedin.com facebook.com instagram.com tiktok.com youtube.com pinterest.com x.com twitter.com reddit.com threads.net"],
    ["media, directory or data provider", "wikipedia.org forbes.com nytimes.com businessinsider.com techcrunch.com medium.com glossy.co modernretail.co retaildive.com vogue.com allure.com cnn.com bloomberg.com wsj.com inc.com fastcompany.com crunchbase.com zoominfo.com rocketreach.co apollo.io pitchbook.com g2.com clutch.co yelp.com bbb.org producthunt.com kickstarter.com indiegogo.com globenewswire.com prnewswire.com businesswire.com substack.com"],
    ["commerce software vendor", "shopify.com bigcommerce.com klaviyo.com yotpo.com attentive.com gorgias.com recharge.com"],
  ].flatMap(([reason, domains]) => domains.split(" ").map((d) => [d, reason])),
);

export function skipNonCandidate(domain: string): string | null {
  for (const [d, reason] of Object.entries(NOT_A_CANDIDATE)) {
    if (domain === d || domain.endsWith(`.${d}`)) return reason;
  }
  return null;
}

const TEXT_RULES: Array<{ rule: string; pattern: RegExp; reason: string }> = [
  { rule: "agency", pattern: /\b(digital|marketing|creative|growth|ecommerce|e-commerce|shopify|branding) (agency|consultancy|studio)\b|\bwe help (brands|merchants|retailers)\b/i, reason: "Describes itself as an agency or consultancy" },
  { rule: "software_vendor", pattern: /\b(saas|software company|software platform|api for|app for shopify|platform (that helps|for) (brands|merchants|retailers))\b/i, reason: "Describes itself as a software vendor" },
  { rule: "marketplace", pattern: /\b(online marketplace|a marketplace (for|of|connecting)|multi-vendor)\b/i, reason: "Describes itself as a marketplace" },
];

/** Rule-based exclusions for real companies. Provider size figures are estimates, so the reason says so. */
export function excludeCandidate(text: string, entity: CompanyEntity | null): Exclusion | null {
  for (const r of TEXT_RULES) if (r.pattern.test(text)) return { rule: r.rule, reason: r.reason };
  if (entity?.employeeCount !== null && entity?.employeeCount !== undefined && entity.employeeCount > 1000) {
    return { rule: "enterprise_scale", reason: `Provider estimate suggests enterprise scale (${entity.employeeCount.toLocaleString("en-US")} employees)` };
  }
  if (entity?.revenueAnnualUsd !== null && entity?.revenueAnnualUsd !== undefined && entity.revenueAnnualUsd > 250e6) {
    return { rule: "enterprise_scale", reason: `Provider estimate suggests enterprise scale ($${Math.round(entity.revenueAnnualUsd / 1e6)}M revenue)` };
  }
  return null;
}

export function companyNameFrom(entityName: string | null, title: string | null, domain: string): string {
  if (entityName) return entityName.slice(0, 200);
  const fromTitle = title?.split(/\s[|\-–—:]\s/)[0]?.trim();
  if (fromTitle && fromTitle.length >= 2 && fromTitle.length <= 60) return fromTitle;
  return domain;
}
