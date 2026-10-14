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
