import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import * as scripts from "../src/browser/pageScripts.ts";

interface FakeElement {
  innerText?: string;
  value?: string;
  textContent?: string;
  href?: string;
  attrs?: Record<string, string>;
  inNav?: boolean;
  visible?: boolean;
}

function element(spec: FakeElement) {
  return {
    ...spec,
    getAttribute: (name: string) => spec.attrs?.[name] ?? null,
    closest: () => (spec.inNav ? {} : null),
    getBoundingClientRect: () => (spec.visible === false ? { width: 0, height: 0 } : { width: 100, height: 40 }),
  };
}

/** A sandbox with no tsx/esbuild helpers, standing in for the remote browser page. */
function fakeBrowser() {
  const bySelector: Record<string, ReturnType<typeof element>[]> = {
    'script[type="application/ld+json"]': [
      element({ textContent: JSON.stringify({ "@graph": [{ "@type": "Product" }, { "@type": ["BreadcrumbList", "Thing"] }] }) }),
      element({ textContent: "{not json" }),
    ],
    "button, input[type=submit], a": [element({ innerText: "Add to Bag" }), element({ innerText: "Add to cart", visible: false })],
    '[role="dialog"], [aria-modal="true"], dialog[open]': [element({}), element({ visible: false })],
    "a[href]": [
      element({ href: "https://x.com/collections/shirts", innerText: "  Shirts ", inNav: true }),
      element({ href: "https://x.com/products/a", innerText: "", attrs: { "aria-label": "Product A" } }),
    ],
  };
  const document = {
    body: { innerText: "Hello shop", scrollHeight: 3000 },
    querySelectorAll: (sel: string) => bySelector[sel] ?? [],
    querySelector: (sel: string) => (sel === 'meta[property="og:type"]' ? element({ attrs: { content: "product" } }) : null),
  };
  const window = {
    innerHeight: 800,
    scrollY: 0,
    scrollBy(_x: number, y: number) {
      this.scrollY += y;
    },
    scrollTo(_x: number, y: number) {
      this.scrollY = y;
    },
  };
  const context = vm.createContext({
    document,
    window,
    navigator: { userAgent: "FakeUA/1.0" },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
  });
  return { context, window };
}

const run = (code: string, context: vm.Context) => vm.runInContext(code, context);

test("browser scripts are plain strings free of build-tool helpers", () => {
  for (const [name, code] of Object.entries(scripts)) {
    assert.equal(typeof code, "string", `${name} must be a string so no transpiler rewrites it`);
    assert.doesNotMatch(code, /__name|__awaiter|__async|__publicField/, `${name} references a build-tool helper`);
    assert.doesNotThrow(() => new vm.Script(code), `${name} is not valid plain JavaScript`);
  }
});

test("page scripts run in a context where __name is undefined (regression: ReferenceError __name)", async () => {
  const { context, window } = fakeBrowser();
  assert.equal(run("typeof __name", context), "undefined");

  assert.equal(run(scripts.USER_AGENT_SCRIPT, context), "FakeUA/1.0");
  assert.equal(run(scripts.PAGE_TEXT_SCRIPT, context), "Hello shop");

  const signals = JSON.parse(JSON.stringify(run(scripts.PAGE_SIGNALS_SCRIPT, context)));
  assert.deepEqual(signals, {
    jsonLdTypes: ["Product", "BreadcrumbList", "Thing"],
    ogType: "product",
    addToCartControlVisible: true,
    visibleDialogCount: 1,
  });

  const links = JSON.parse(JSON.stringify(run(scripts.PAGE_LINKS_SCRIPT, context)));
  assert.deepEqual(links, [
    { href: "https://x.com/collections/shirts", text: "Shirts", inNav: true },
    { href: "https://x.com/products/a", text: "Product A", inNav: false },
  ]);

  await run(scripts.SCROLL_THROUGH_SCRIPT, context);
  assert.equal(window.scrollY, 0);
});

test("the tsx runtime does inject __name into nested named functions (why scripts must be strings)", () => {
  const transpiled = () => {
    const inner = () => 1;
    return inner();
  };
  if (!transpiled.toString().includes("__name")) return;
  const { context } = fakeBrowser();
  assert.throws(() => run(`(${transpiled.toString()})()`, context), /__name is not defined/);
});

interface NodeSpec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  position?: string;
  display?: string;
  z?: number;
  rect?: [number, number, number, number];
  children?: NodeSpec[];
}

/** Minimal DOM: enough layout, styles and hit testing for the overlay scan to run unmodified. */
function fakeOverlayPage(tree: NodeSpec[], vw: number, vh: number, hostname = "shop.test") {
  const all: any[] = [];
  const build = (spec: NodeSpec, parent: any): any => {
    const node: any = {
      tagName: spec.tag.toUpperCase(),
      id: spec.attrs?.id ?? "",
      className: spec.attrs?.class ?? "",
      parent,
      style: { position: spec.position ?? "static", display: spec.display ?? "block", visibility: "visible", opacity: "1" },
      getAttribute: (n: string) => spec.attrs?.[n] ?? null,
      get innerText(): string {
        return [spec.text ?? "", ...node.children.map((c: any) => c.innerText)].filter(Boolean).join(" ");
      },
      get z(): number {
        return spec.z ?? parent?.z ?? 0;
      },
      getBoundingClientRect() {
        const [x, y, w, h] = spec.rect ?? [0, 0, 0, 0];
        return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
      },
      descendants(): any[] {
        return node.children.flatMap((c: any) => [c, ...c.descendants()]);
      },
      contains(other: any) {
        for (let n = other; n; n = n.parent) if (n === node) return true;
        return false;
      },
      getElementsByTagName: (t: string) => node.descendants().filter((d: any) => t === "*" || d.tagName === t.toUpperCase()),
      querySelectorAll(sel: string) {
        if (sel === "*") return node.descendants();
        return node.descendants().filter(
          (d: any) =>
            ["BUTTON", "A"].includes(d.tagName) ||
            d.getAttribute("role") === "button" ||
            d.getAttribute("aria-label") !== null ||
            (d.tagName === "INPUT" && ["button", "submit"].includes(d.getAttribute("type"))),
        );
      },
    };
    all.push(node);
    node.children = (spec.children ?? []).map((c) => build(c, node));
    return node;
  };
  const body = build({ tag: "body", rect: [0, 0, vw, vh], children: tree }, null);
  const document = {
    body,
    elementFromPoint(x: number, y: number) {
      let best: any = null;
      for (const n of all) {
        const r = n.getBoundingClientRect();
        if (n.style.display === "none" || x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
        if (!best || n.z >= best.z) best = n;
      }
      return best;
    },
  };
  return vm.createContext({
    window: { innerWidth: vw, innerHeight: vh },
    document,
    location: { hostname },
    getComputedStyle: (el: any) => el.style,
  });
}

test("overlay scan finds stacked consent and promo overlays without touching the page", () => {
  const ctx = fakeOverlayPage(
    [
      { tag: "header", position: "sticky", rect: [0, 0, 390, 60], text: "Shop Menu" },
      { tag: "main", rect: [0, 60, 390, 2000], text: "Product details" },
      { tag: "div", position: "fixed", display: "none", rect: [0, 0, 390, 844], text: "Subscribe to our newsletter" },
      { tag: "iframe", position: "fixed", rect: [320, 770, 60, 60], attrs: { title: "Chat" } },
      {
        tag: "div",
        attrs: { id: "onetrust-banner-sdk" },
        position: "fixed",
        z: 5,
        rect: [0, 644, 390, 200],
        text: "We use cookies to improve your experience.",
        children: [
          { tag: "button", text: "Cookie Settings", rect: [10, 700, 120, 40] },
          { tag: "button", text: "Reject All", rect: [140, 700, 110, 40] },
          { tag: "button", text: "Accept All", rect: [260, 700, 120, 40] },
        ],
      },
      {
        tag: "div",
        attrs: { role: "dialog", "aria-modal": "true" },
        position: "fixed",
        z: 10,
        rect: [0, 0, 390, 844],
        text: "Get 15% off your first order",
        children: [
          { tag: "input", attrs: { type: "email", placeholder: "Email" }, rect: [20, 300, 350, 48] },
          { tag: "button", text: "Sign up", rect: [20, 360, 350, 48] },
          { tag: "button", text: "No, thanks", rect: [20, 420, 350, 40] },
          { tag: "button", text: "×", attrs: { "aria-label": "Close dialog" }, rect: [340, 10, 40, 40] },
        ],
      },
    ],
    390,
    844,
  );
  assert.equal(vm.runInContext("typeof __name", ctx), "undefined");
  const result = JSON.parse(JSON.stringify(vm.runInContext(scripts.OVERLAY_SCAN_PAGE_SCRIPT, ctx)));

  assert.deepEqual(result.viewport, { width: 390, height: 844 });
  assert.deepEqual(
    result.overlays.map((o: any) => [o.kind, o.tag, o.coverage]),
    [
      ["consent", "div", 0.237],
      ["promotional", "div", 1],
    ],
  );
  const [consent, promo] = result.overlays;
  assert.match(consent.label, /We use cookies/);
  assert.deepEqual(
    consent.controls.map((c: any) => [c.label, c.intent, c.hitTestOk]),
    [
      ["Reject All", "decline", false],
      ["Accept All", "accept", false],
    ],
    "consent buttons are found but recorded as covered by the promo modal; settings is not a dismiss control",
  );
  assert.deepEqual(
    promo.controls.map((c: any) => [c.label, c.intent, c.hitTestOk, c.x, c.y]),
    [
      ["No, thanks", "decline", true, 195, 440],
      ["×", "close", true, 360, 30],
    ],
    "sign-up is never treated as a dismiss control",
  );
});

test("overlay frame scan classifies an SMS sign-up iframe and lists its close control", () => {
  const ctx = fakeOverlayPage(
    [
      { tag: "p", text: "Text me 20% off", rect: [0, 0, 300, 40] },
      { tag: "button", attrs: { "aria-label": "Dismiss this popup" }, rect: [270, 0, 30, 30] },
    ],
    300,
    500,
    "creatives.attn.tv",
  );
  const result = JSON.parse(JSON.stringify(vm.runInContext(scripts.OVERLAY_SCAN_FRAME_SCRIPT, ctx)));
  assert.equal(result.kind, "promotional");
  assert.match(result.label, /20% off/);
  assert.deepEqual(result.controls.map((c: any) => [c.label, c.intent, c.hitTestOk]), [["Dismiss this popup", "close", true]]);
});

test("no source file passes a TypeScript function to page.evaluate", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        const pattern = /\.(evaluate|evaluateHandle|\$eval|\$\$eval|waitForFunction|addInitScript)\s*(<[^>]*>)?\s*\(\s*(async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g;
        for (const m of source.matchAll(pattern)) offenders.push(`${path}: ${m[0]}`);
      }
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});
