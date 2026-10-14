/**
 * Code that runs inside the remote browser. It is kept as plain JavaScript strings because
 * tsx/esbuild rewrite TypeScript functions (e.g. injecting `__name(...)` helpers) and Playwright
 * serialises functions via toString(), so injected helpers would be undefined in the page.
 */

export const USER_AGENT_SCRIPT = `navigator.userAgent`;

export const PAGE_TEXT_SCRIPT = `(document.body ? document.body.innerText : "") || ""`;

export const PAGE_SIGNALS_SCRIPT = `(() => {
  const types = [];
  function collect(node) {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node && typeof node === "object") {
      const t = node["@type"];
      if (typeof t === "string") types.push(t);
      if (Array.isArray(t)) t.forEach((x) => { if (typeof x === "string") types.push(x); });
      if (node["@graph"]) collect(node["@graph"]);
    }
  }
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try { collect(JSON.parse(el.textContent || "")); } catch (e) { /* malformed JSON-LD is ignored */ }
  });
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  const addToCart = Array.from(document.querySelectorAll("button, input[type=submit], a")).some(
    (el) => /add to (cart|bag)/i.test(el.innerText || el.value || "") && isVisible(el)
  );
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')).filter(isVisible);
  const og = document.querySelector('meta[property="og:type"]');
  return {
    jsonLdTypes: Array.from(new Set(types)),
    ogType: og ? og.getAttribute("content") : null,
    addToCartControlVisible: addToCart,
    visibleDialogCount: dialogs.length,
  };
})()`;

export const PAGE_LINKS_SCRIPT = `Array.from(document.querySelectorAll("a[href]")).map((a) => ({
  href: a.href,
  text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120),
  inNav: !!a.closest("nav, header, [role=navigation]"),
}))`;

export const SCROLL_THROUGH_SCRIPT = `(async () => {
  const step = window.innerHeight;
  for (let i = 0; i < 8 && window.scrollY + step < document.body.scrollHeight; i++) {
    window.scrollBy(0, step);
    await new Promise((r) => setTimeout(r, 250));
  }
  window.scrollTo(0, 0);
})()`;
