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

  const CONTROL_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"], [aria-label]';
  const CMP_CONTAINER = /onetrust|cookiebot|didomi|usercentrics|osano|truste|termly|shopify-pc__banner|cookie-?(banner|consent|notice|bar|law)|consent-?(banner|bar|notice)|gdpr|cc-window|privacy-banner/i;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el.innerText || el.textContent || (el.shadowRoot ? el.shadowRoot.textContent : "") || "");
  const hintOf = (el) => [el.id || "", typeof el.className === "string" ? el.className : "", el.getAttribute("aria-label") || "", el.getAttribute("title") || "", el.getAttribute("src") || ""].join(" ");
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const deepContains = (a, b) => {
    for (let n = b; n; n = parentOf(n)) if (n === a) return true;
    return false;
  };
  // Elements under root, including those inside open shadow roots.
  const descendants = (root) => {
    const out = [];
    const walk = (node) => {
      if (node.shadowRoot) walk(node.shadowRoot);
      const els = node.querySelectorAll("*");
      for (let i = 0; i < els.length; i++) {
        out.push(els[i]);
        if (els[i].shadowRoot) walk(els[i].shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const topAt = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const styleShown = (s) => s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    return styleShown(getComputedStyle(el));
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
    descendants(root).forEach((el) => {
      if (seen.has(el) || !el.matches || !el.matches(CONTROL_SELECTOR) || !visible(el)) return;
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
      const hit = topAt(x, y);
      out.push({ label: label || "(icon without text)", intent, tag, x, y, hitTestOk: !!hit && deepContains(el, hit) });
    });
    return out;
  };

  if (mode === "frame") {
    const body = document.body;
    const text = body ? textOf(body).slice(0, 2000) : "";
    return { kind: classify(text, location.hostname), label: text.slice(0, 160), controls: body ? controlsIn(body) : [] };
  }

  const candidates = [];
  const consider = (el, position, modal, knownConsent) => {
    if (candidates.some((c) => c.el === el) || !visible(el)) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const coverage = (w * h) / (vw * vh);
    const isFrame = el.tagName === "IFRAME";
    const text = isFrame ? "" : textOf(el).slice(0, 2000);
    const kind = knownConsent ? "consent" : classify(text, hintOf(el));
    const banner = w >= vw * 0.6 && h >= 48;
    if (!isFrame && el.getElementsByTagName("a").length > 40) return;
    if (kind === "other") {
      if (position === "sticky") return;
      if (!modal && !isFrame && (coverage < 0.3 || !text)) return;
      if (isFrame && coverage < 0.15) return;
    } else if (coverage < 0.05 && !banner) return;
    candidates.push({ el, kind, text, coverage, isFrame });
  };
  // A fixed wrapper with no size of its own (common for consent tools) still shows its children.
  const shownChildren = (el, depth) => {
    const out = [];
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (visible(kids[i])) out.push(kids[i]);
      else if (depth < 3) out.push(...shownChildren(kids[i], depth + 1));
    }
    return out;
  };
  const all = document.body ? descendants(document.body) : [];
  for (const el of all) {
    const role = el.getAttribute("role");
    const modal = role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true" || (el.tagName === "DIALOG" && el.open);
    const s = getComputedStyle(el);
    if (s.position === "fixed" || s.position === "sticky" || modal) {
      if (visible(el)) consider(el, s.position, modal, false);
      else if (s.position === "fixed" && styleShown(s)) shownChildren(el, 0).forEach((child) => consider(child, "fixed", modal, false));
    } else if (CMP_CONTAINER.test((el.id || "") + " " + (typeof el.className === "string" ? el.className : "")) && visible(el) && CONSENT_TEXT.test(textOf(el)) && controlsIn(el).length) {
      // Known consent banners are reported wherever they are positioned.
      consider(el, s.position, modal, true);
    }
  }
  const inside = (outer, c) => outer !== c && deepContains(outer.el, c.el);
  const directChildren = (parent) => candidates.filter((c) => inside(parent, c) && !candidates.some((o) => inside(parent, o) && inside(o, c)));
  // A container holding overlays of different kinds (e.g. a promo and a cookie banner) is a wrapper, not one overlay.
  const split = (c) => {
    const kids = directChildren(c);
    return kids.length >= 2 && new Set(kids.map((k) => k.kind)).size >= 2 ? kids.flatMap(split) : [c];
  };
  const tops = candidates.filter((c) => !candidates.some((o) => inside(o, c))).flatMap(split);
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
