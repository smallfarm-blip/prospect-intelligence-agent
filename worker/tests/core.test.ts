import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBlock } from "../src/capture.ts";
import { loadConfig, parseSites } from "../src/config.ts";
import { CostTracker, unitsForSession } from "../src/cost.ts";
import { classifyLink, pickContrastingPdps, productLinks, rankPlpCandidates, type PageLink } from "../src/discovery.ts";
import { isPathAllowed, parseRobots, type RobotsRules } from "../src/robots.ts";
import { canonicalizeUrl, isSameSite, normalizeDomain } from "../src/url.ts";

test("robots: only the * group applies, longest match wins, Allow wins ties", () => {
  const parsed = parseRobots(`
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /checkout
Disallow: /collections/*?filter
Allow: /collections/sale-items$
Disallow: /collections/sale
Crawl-delay: 2
`);
  const rules: RobotsRules = { status: "parsed", ...parsed };
  assert.equal(rules.crawlDelaySeconds, 2);
  assert.equal(isPathAllowed(rules, "/"), true);
  assert.equal(isPathAllowed(rules, "/checkout/step1"), false);
  assert.equal(isPathAllowed(rules, "/collections/shirts?filter=red"), false);
  assert.equal(isPathAllowed(rules, "/collections/shirts"), true);
  assert.equal(isPathAllowed(rules, "/collections/sale-items"), true);
  assert.equal(isPathAllowed(rules, "/collections/sale-items-2"), false);
  assert.equal(isPathAllowed({ ...rules, allow: ["/checkout"], disallow: ["/checkout"] }, "/checkout"), true);
});

test("robots: absent file allows everything, unreachable file disallows everything", () => {
  const empty = { allow: [], disallow: [], crawlDelaySeconds: null };
  assert.equal(isPathAllowed({ status: "absent", ...empty, disallow: ["/"] }, "/x"), true);
  assert.equal(isPathAllowed({ status: "unreachable", ...empty }, "/"), false);
});

test("url helpers normalise domains and strip tracking parameters", () => {
  assert.equal(normalizeDomain("https://WWW.Kosas.com/"), "kosas.com");
  assert.equal(isSameSite("https://shop.kosas.com/x", "kosas.com"), true);
  assert.equal(isSameSite("https://kosas.com.evil.io/x", "kosas.com"), false);
  assert.equal(
    canonicalizeUrl("https://kosas.com/products/a/?utm_source=x&variant=123&color=red#reviews"),
    "https://kosas.com/products/a?color=red",
  );
});

test("discovery: classifies product, listing and excluded links", () => {
  assert.equal(classifyLink("https://x.com/products/linen-shirt"), "pdp");
  assert.equal(classifyLink("https://x.com/collections/mens/products/linen-shirt"), "pdp");
  assert.equal(classifyLink("https://x.com/collections/shirts"), "plp");
  assert.equal(classifyLink("https://x.com/collections/frontpage"), "other");
  assert.equal(classifyLink("https://x.com/products/gift-card"), "other");
  assert.equal(classifyLink("https://x.com/pages/about"), "other");
  assert.equal(classifyLink("https://x.com/cart"), "other");
  assert.equal(classifyLink("not a url"), "other");
});

test("discovery: ranks navigation listing links first and drops off-site duplicates", () => {
  const links: PageLink[] = [
    { href: "https://x.com/collections/sale", text: "Sale", inNav: true },
    { href: "https://x.com/collections/footer-only", text: "Footer", inNav: false },
    { href: "https://x.com/collections/shop-all", text: "Shop All", inNav: true },
    { href: "https://x.com/collections/shop-all?utm_source=nav", text: "Shop All", inNav: true },
    { href: "https://other.com/collections/shirts", text: "Shirts", inNav: true },
  ];
  const ranked = rankPlpCandidates(links, "x.com", 5).map((l) => l.href);
  assert.deepEqual(ranked, ["https://x.com/collections/shop-all", "https://x.com/collections/sale", "https://x.com/collections/footer-only"]);
});

test("discovery: picks two distinct products spread across the listing", () => {
  const products = productLinks(
    Array.from({ length: 9 }, (_, i) => ({ href: `https://x.com/products/p${i}`, text: `P${i}`, inNav: false })),
    "x.com",
  );
  const picked = pickContrastingPdps(products).map((p) => p.href);
  assert.deepEqual(picked, ["https://x.com/products/p0", "https://x.com/products/p6"]);
  assert.equal(pickContrastingPdps(products.slice(0, 1)).length, 1);
});

test("cost: units are per 30s of session, rounded up, minimum one", () => {
  assert.equal(unitsForSession(0), 1);
  assert.equal(unitsForSession(30_000), 1);
  assert.equal(unitsForSession(30_001), 2);
  assert.equal(unitsForSession(110_000), 4);
});

test("cost: refuses a session whose worst case would exceed the ceiling", () => {
  const tracker = new CostTracker(10, 1, 0.002, 110_000);
  assert.equal(tracker.canStartSession(), true);
  tracker.record("a", 45_000);
  tracker.record("b", 61_000);
  assert.equal(tracker.estimatedUnits, 5);
  assert.equal(tracker.sessionSeconds, 106);
  assert.equal(tracker.estimatedCostUsd, 0.01);
  assert.equal(tracker.canStartSession(), true);
  tracker.record("c", 60_000);
  assert.equal(tracker.canStartSession(), false);
  assert.equal(tracker.ceilingHit, true);

  const dollarCapped = new CostTracker(1000, 0.005, 0.002, 30_000);
  dollarCapped.record("a", 30_000);
  dollarCapped.record("b", 30_000);
  assert.equal(dollarCapped.canStartSession(), false);
});

test("block detection flags access controls, not ordinary pages", () => {
  assert.match(detectBlock(403, "Shop", "")!, /403/);
  assert.match(detectBlock(429, "Shop", "")!, /429/);
  assert.match(detectBlock(200, "Just a moment...", "")!, /challenge/);
  assert.match(detectBlock(200, "Kosas", "Please verify you are human")!, /CAPTCHA/);
  assert.equal(detectBlock(200, "Kosas", "captcha ".repeat(300)), null);
  assert.equal(detectBlock(200, "Linen Shirt | Taylor Stitch", "Add to cart"), null);
});

test("site config rejects jewelry and incomplete entries", () => {
  const sites = parseSites({ sites: [{ name: "A", domain: "https://www.a.com", category: "apparel" }] });
  assert.equal(sites[0].domain, "a.com");
  assert.deepEqual(sites[0].fallback, { plp: null, pdps: [] });
  assert.throws(() => parseSites({ sites: [{ name: "J", domain: "j.com", category: "Jewelry" }] }), /excluded/);
  assert.throws(() => parseSites({ sites: [{ name: "B" }] }), /needs name/);
  assert.throws(() => parseSites({ sites: [] }), /non-empty/);
});

test("worker config requires secrets and refuses a publishable key", () => {
  assert.throws(() => loadConfig({}), /SUPABASE_URL, SUPABASE_SECRET_KEY, BROWSERLESS_TOKEN/);
  assert.throws(
    () => loadConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_publishable_abc", BROWSERLESS_TOKEN: "t" }),
    /publishable/,
  );
  const config = loadConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_abc", BROWSERLESS_TOKEN: "t" });
  assert.equal(config.sites.length, 3);
  assert.deepEqual(config.sites.map((s) => s.category).sort(), ["apparel", "beauty", "home_goods"]);
});
