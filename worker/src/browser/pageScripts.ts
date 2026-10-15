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

/**
 * Finds visible overlays (fixed/sticky layers, dialogs, overlay iframes) and the visible controls
 * inside them that a visitor could use to close, decline or accept. Read-only: it never changes
 * the page. Coordinates are relative to the frame the script runs in.
 * In "frame" mode it describes the whole document of an overlay iframe instead.
 */
const OVERLAY_SCAN_SOURCE = String.raw`(mode) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const CONSENT_TEXT = /cookie|consent|gdpr|ccpa|do not sell|your privacy|privacy (preferences|choices|settings)|tracking technologies/i;
  const CONSENT_HINT = /onetrust|cookie|consent|cmp|didomi|truste|usercentrics|cookiebot|osano|termly/i;
  const PROMO_TEXT = /\d+\s?% off|sign up|subscribe|newsletter|join (our|the)|enter your email|email address|phone number|text (me|us)|sms|discount|unlock|first order|exclusive offer|free shipping|welcome offer|spin to win/i;
  const PROMO_HINT = /klaviyo|attentive|privy|justuno|wisepops|omnisend|postscript|popup|pop-up|newsletter|promo|optin|opt-in|email-capture/i;
  const CLOSE_LABEL = /^(×|✕|✖|x|close|close dialog|close modal|close popup|close pop-up|close banner|dismiss|close this dialog)$/i;
  const CLOSE_ATTR = /close|dismiss/i;
  const DECLINE_LABEL = /no,? thanks?|no thank you|not now|maybe later|decline|reject|deny|continue without accepting|necessary (cookies )?only|only (strictly )?necessary|essential (cookies )?only|i('|’)?ll pass|i('|’)?d rather pay full price|skip/i;
  const ACCEPT_LABEL = /^(accept|accept all|accept all cookies|accept cookies|allow|allow all|allow all cookies|allow cookies|agree|i agree|agree and close|accept and close|ok|okay|got it|i understand|understood)$/i;
  const FORM_ACTION = /sign ?up|subscribe|claim|unlock|get \d|submit|shop now|sign in|log ?in|join|continue to|save preferences|manage|customi[sz]e|settings|preferences/i;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el.innerText || el.textContent || "");
  const hintOf = (el) => [el.id || "", typeof el.className === "string" ? el.className : "", el.getAttribute("aria-label") || "", el.getAttribute("title") || "", el.getAttribute("src") || ""].join(" ");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const classify = (text, hint) => {
    if (CONSENT_TEXT.test(text) || CONSENT_HINT.test(hint)) return "consent";
    if (PROMO_TEXT.test(text) || PROMO_HINT.test(hint)) return "promotional";
    return "other";
  };
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };

  const controlsIn = (root) => {
    const out = [];
    const seen = new Set();
    root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [aria-label]').forEach((el) => {
      if (seen.has(el) || !visible(el)) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") {
        const href = el.getAttribute("href") || "";
        if (href && href.charAt(0) !== "#" && !/^javascript:/i.test(href)) return;
      }
      const label = clean(textOf(el) || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "").slice(0, 80);
      const aria = el.getAttribute("aria-label") || "";
      let intent = null;
      if (CLOSE_LABEL.test(label) || CLOSE_ATTR.test(aria) || (label.length <= 1 && CLOSE_ATTR.test(hintOf(el)))) intent = "close";
      else if (label.length <= 60 && DECLINE_LABEL.test(label) && !/accept/i.test(label)) intent = "decline";
      else if (ACCEPT_LABEL.test(label)) intent = "accept";
      if (!intent || (intent !== "close" && FORM_ACTION.test(label) && !DECLINE_LABEL.test(label))) return;
      el.querySelectorAll("*").forEach((child) => seen.add(child));
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      out.push({ label: label || "(icon without text)", intent, tag, x, y, hitTestOk: !!hit && (hit === el || el.contains(hit)) });
    });
    return out;
  };

  if (mode === "frame") {
    const body = document.body;
    const text = body ? textOf(body).slice(0, 2000) : "";
    return { kind: classify(text, location.hostname), label: text.slice(0, 160), controls: body ? controlsIn(body) : [] };
  }

  const candidates = [];
  const all = document.body ? document.body.getElementsByTagName("*") : [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const role = el.getAttribute("role");
    const modal = role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true" || (el.tagName === "DIALOG" && el.open);
    const s = getComputedStyle(el);
    if (!(s.position === "fixed" || s.position === "sticky" || modal)) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const coverage = (w * h) / (vw * vh);
    const isFrame = el.tagName === "IFRAME";
    const text = isFrame ? "" : textOf(el).slice(0, 2000);
    const kind = classify(text, hintOf(el));
    const banner = w >= vw * 0.6 && h >= 48;
    if (!isFrame && el.getElementsByTagName("a").length > 40) continue;
    if (kind === "other") {
      if (s.position === "sticky") continue;
      if (!modal && !isFrame && (coverage < 0.3 || !text)) continue;
      if (isFrame && coverage < 0.15) continue;
    } else if (coverage < 0.05 && !banner) continue;
    candidates.push({ el, kind, text, coverage, isFrame, modal });
  }
  const tops = candidates.filter((c) => !candidates.some((o) => o !== c && o.el.contains(c.el)));
  return {
    viewport: { width: vw, height: vh },
    overlays: tops.map((c) => ({
      kind: c.kind,
      label: c.isFrame ? clean(c.el.getAttribute("title") || c.el.getAttribute("name") || "") : c.text.slice(0, 160),
      tag: c.el.tagName.toLowerCase(),
      isFrame: c.isFrame,
      coverage: Math.round(c.coverage * 1000) / 1000,
      box: boxOf(c.el),
      controls: c.isFrame ? [] : controlsIn(c.el),
    })),
  };
}`;

export const OVERLAY_SCAN_PAGE_SCRIPT = `(${OVERLAY_SCAN_SOURCE})("page")`;
export const OVERLAY_SCAN_FRAME_SCRIPT = `(${OVERLAY_SCAN_SOURCE})("frame")`;
