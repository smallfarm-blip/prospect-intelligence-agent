import { fetchRobots, isPathAllowed } from "../robots.ts";
import type { NewFact } from "./ports.ts";

export interface SiteCheck {
  status: "checked" | "blocked_by_robots" | "unreachable";
  url: string;
  title: string | null;
  description: string | null;
  platform: string | null;
  pageText: string;
  facts: NewFact[];
  notes: string[];
}

const PLATFORMS: Array<[string, RegExp]> = [
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme/i],
  ["BigCommerce", /cdn\d*\.bigcommerce\.com/i],
  ["Salesforce Commerce Cloud", /demandware/i],
  ["WooCommerce", /woocommerce/i],
  ["Magento", /mage\/cookies|Magento_/i],
];

const TESTING_TOOLS: Array<[string, RegExp]> = [
  ["Optimizely", /optimizely\.com/i],
  ["VWO", /visualwebsiteoptimizer|vwo_code/i],
  ["AB Tasty", /abtasty/i],
  ["Convert", /cdn-\d+\.convertexperiments|convert\.com\/js/i],
  ["Kameleoon", /kameleoon/i],
  ["Dynamic Yield", /dynamicyield/i],
  ["Intelligems", /intelligems/i],
  ["Monetate", /monetate/i],
  ["Nosto", /nosto/i],
  ["Rebuy", /rebuyengine/i],
];

const PROMOTION_TOOLS: Array<[string, RegExp]> = [
  ["Klaviyo forms", /static\.klaviyo\.com|klaviyo\.js/i],
  ["Attentive", /attn\.tv|attentivemobile/i],
  ["Privy", /privy\.com|widget\.privy/i],
  ["Justuno", /justuno/i],
  ["Postscript", /postscript\.io/i],
  ["Omnisend", /omnisend/i],
  ["OptinMonster", /optinmonster|omappapi/i],
  ["Wisepops", /wisepops/i],
];

const UA = "Mozilla/5.0 (compatible; ProspectResearchWorker/0.2; homepage check)";

async function getText(url: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const text = (await res.text()).slice(0, 2_000_000);
    return { status: res.status, text };
  } catch {
    return null;
  }
}

function meta(html: string, name: string): string | null {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']{1,500})["']`, "i")) ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,500})["'][^>]*(?:name|property)=["']${name}["']`, "i"));
  return m ? decode(m[1]).trim() : null;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

export function visibleText(html: string, maxChars: number): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  )
    .trim()
    .slice(0, maxChars);
}

/**
 * Free homepage check that respects robots.txt: platform, direct store, testing and pop-up tools,
 * and the Shopify catalogue size. Detection only sees the homepage HTML, so tool findings are inferences.
 */
export async function checkSite(domain: string, opts: { timeoutMs: number; maxTextChars: number }): Promise<SiteCheck> {
  const url = `https://${domain}/`;
  const empty: SiteCheck = { status: "unreachable", url, title: null, description: null, platform: null, pageText: "", facts: [], notes: [] };
  const robots = await fetchRobots(domain);
  if (!isPathAllowed(robots, "/")) return { ...empty, status: "blocked_by_robots", notes: [`robots.txt ${robots.status === "unreachable" ? "unreachable, so the homepage was not fetched" : "disallows the homepage"}`] };

  const page = await getText(url, opts.timeoutMs);
  if (!page || page.status >= 400) return { ...empty, notes: [page ? `Homepage returned ${page.status}` : "Homepage unreachable"] };
  const html = page.text;
  const checkedAt = new Date().toISOString();
  const fact = (attribute: NewFact["attribute"], valueText: string, valueNumber: number | null, status: NewFact["status"], excerpt: string | null, sourceUrl = url): NewFact => ({
    attribute,
    valueText,
    valueNumber,
    status,
    sourceType: "company_site",
    sourceUrl,
    provider: null,
    excerpt,
    providerCallId: null,
    checkedAt,
  });

  const facts: NewFact[] = [];
  const notes: string[] = [];
  const platform = PLATFORMS.find(([, re]) => re.test(html))?.[0] ?? null;
  if (platform) facts.push(fact("ecommerce_platform", platform, null, "verified", "Detected in homepage source"));
  const hasCart = /href=["'][^"']*\/cart["']|add[-_ ]to[-_ ]cart|\/checkout/i.test(html);
  if (platform || hasCart) facts.push(fact("sells_dtc", "yes", null, "verified", platform ? `${platform} storefront on the company's own domain` : "Cart or checkout links on the company's own domain"));

  const testing = TESTING_TOOLS.filter(([, re]) => re.test(html)).map(([n]) => n);
  facts.push(fact("experimentation_tools", testing.length ? testing.join(", ") : "none detected", testing.length, "inferred", "Homepage source only; tools loaded later or server-side are not visible"));
  const promos = PROMOTION_TOOLS.filter(([, re]) => re.test(html)).map(([n]) => n);
  facts.push(fact("promotion_tools", promos.length ? promos.join(", ") : "none detected", promos.length, "inferred", "Homepage source only; shows the tool is installed, not when or how it interrupts visitors"));

  if (platform === "Shopify") {
    const productsUrl = `https://${domain}/products.json?limit=250`;
    if (isPathAllowed(robots, "/products.json?limit=250")) {
      const products = await getText(productsUrl, opts.timeoutMs);
      try {
        const list = products && products.status < 400 ? (JSON.parse(products.text) as { products?: unknown[] }).products : undefined;
        if (Array.isArray(list)) facts.push(fact("catalog_size", list.length >= 250 ? "250+" : String(list.length), list.length, "verified", "Public Shopify product feed (first page)", productsUrl));
      } catch {
        notes.push("Product feed was not JSON");
      }
    } else notes.push("robots.txt disallows the product feed");
  }

  const currency = html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/)?.[1] ?? meta(html, "og:price:currency");
  if (currency) notes.push(`Store currency on the homepage: ${currency}`);
  const title = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? null;
  return {
    status: "checked",
    url,
    title: title ? decode(title) : null,
    description: meta(html, "description") ?? meta(html, "og:description"),
    platform,
    pageText: visibleText(html, opts.maxTextChars),
    facts,
    notes,
  };
}
