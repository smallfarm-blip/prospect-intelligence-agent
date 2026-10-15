import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCaptureStates,
  dismissOverlays,
  type ControlIntent,
  type DetectedOverlay,
  type OverlayDriver,
  type OverlayKind,
} from "../src/overlays.ts";

let coord = 0;

function overlay(kind: OverlayKind, label: string, controls: Array<[string, ControlIntent, boolean?]>, y = 0): DetectedOverlay {
  return {
    kind,
    label,
    tag: "div",
    isFrame: false,
    frameUrl: null,
    coverage: 0.5,
    box: { x: 0, y, width: 390, height: 400 },
    controls: controls.map(([l, intent, hit = true]) => ({ label: l, intent, tag: "button", x: ++coord, y: coord, hitTestOk: hit })),
  };
}

type Effect = (page: FakePage) => void;

class FakePage implements OverlayDriver {
  url = "https://shop.test/products/a";
  presses: string[] = [];
  waits = 0;
  constructor(
    public visible: DetectedOverlay[],
    private effects: Record<string, Effect> = {},
  ) {}
  async scan() {
    return this.visible.map((o) => structuredClone(o));
  }
  async activate(x: number, y: number) {
    const control = this.visible.flatMap((o) => o.controls).find((c) => c.x === x && c.y === y);
    assert.ok(control, `pressed a point with no visible control (${x},${y})`);
    this.presses.push(control.label);
    this.effects[control.label]?.(this);
  }
  currentUrl() {
    return this.url;
  }
  async wait() {
    this.waits++;
  }
  remove(label: string) {
    this.visible = this.visible.filter((o) => o.label !== label);
  }
}

test("nothing is pressed when no overlay is detected", async () => {
  const page = new FakePage([]);
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "none_detected");
  assert.deepEqual(r.actions, []);
  assert.deepEqual(page.presses, []);
});

test("stacked promo and consent overlays: promo closed first, then consent declined rather than accepted", async () => {
  const consent = overlay("consent", "We use cookies to improve your experience", [["Accept All", "accept", false], ["Reject All", "decline", false]], 644);
  const promo = overlay("promotional", "Get 15% off your first order", [["×", "close"]]);
  const page = new FakePage([consent, promo], {
    "×": (p) => {
      p.remove(promo.label);
      for (const c of p.visible[0].controls) c.hitTestOk = true;
    },
    "Reject All": (p) => p.remove(consent.label),
  });

  const r = await dismissOverlays(page, { method: "tap", settleMs: 0 });
  assert.equal(r.status, "all_dismissed");
  assert.deepEqual(page.presses, ["×", "Reject All"]);
  assert.deepEqual(
    r.actions.map((a) => [a.overlay.kind, a.control?.label, a.control?.intent, a.method, a.outcome, a.firstSeen]),
    [
      ["promotional", "×", "close", "tap", "dismissed", "initial"],
      ["consent", "Reject All", "decline", "tap", "dismissed", "initial"],
    ],
  );
  assert.equal(r.initialOverlays.length, 2);
  assert.deepEqual(r.remainingOverlays, []);
  assert.deepEqual(r.initialOverlays[0].controlsFound, [
    { label: "Accept All", intent: "accept", pressable: false },
    { label: "Reject All", intent: "decline", pressable: false },
  ]);
});

test("an overlay that survives its control is recorded as still visible and pressed only once", async () => {
  const promo = overlay("promotional", "Join our newsletter", [["Close", "close"]]);
  const page = new FakePage([promo]);
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "not_dismissed");
  assert.deepEqual(page.presses, ["Close"]);
  assert.equal(r.actions[0].outcome, "still_visible");
  assert.equal(r.remainingOverlays.length, 1);
  assert.equal(page.waits, 2, "waits once more before concluding it is still visible");
});

test("covered controls and overlays without a dismiss control are left alone and explained", async () => {
  const covered = overlay("promotional", "Unlock 10% off", [["Close", "close", false]]);
  const acceptOnlyPromo = overlay("promotional", "Sign up for texts", [["OK", "accept"]], 500);
  const page = new FakePage([covered, acceptOnlyPromo]);
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "not_dismissed");
  assert.deepEqual(page.presses, [], "never presses a covered control or accepts a promotion");
  assert.deepEqual(r.actions.map((a) => [a.overlay.label, a.outcome, a.control]), [
    ["Unlock 10% off", "control_obscured", null],
    ["Sign up for texts", "no_dismiss_control_found", null],
  ]);
  assert.equal(r.remainingOverlays.length, 2);
});

test("stops immediately if a control navigates away", async () => {
  const promo = overlay("promotional", "Free shipping today", [["No thanks", "decline"]]);
  const other = overlay("consent", "Cookie notice", [["Decline", "decline"]], 600);
  const page = new FakePage([promo, other], { "No thanks": (p) => (p.url = "https://shop.test/collections/sale") });
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "navigated_away");
  assert.deepEqual(page.presses, ["No thanks"]);
  assert.equal(r.actions.length, 1);
  assert.match(r.actions[0].detail, /collections\/sale/);
});

test("an overlay that appears after the first dismissal is handled and marked as later", async () => {
  const consent = overlay("consent", "Your privacy choices", [["Decline", "decline"]], 700);
  const promo = overlay("promotional", "Spin to win", [["Close", "close"]]);
  const page = new FakePage([consent], {
    Decline: (p) => (p.visible = [promo]),
    Close: (p) => p.remove(promo.label),
  });
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "all_dismissed");
  assert.deepEqual(r.actions.map((a) => [a.overlay.label, a.firstSeen, a.outcome]), [
    ["Your privacy choices", "initial", "dismissed"],
    ["Spin to win", "later", "dismissed"],
  ]);
  assert.equal(r.initialOverlays.length, 1);
});

test("consent with only an accept control uses it as a last resort", async () => {
  const consent = overlay("consent", "This site uses cookies", [["Got it", "accept"]]);
  const page = new FakePage([consent], { "Got it": (p) => p.remove(consent.label) });
  const r = await dismissOverlays(page, { method: "click", settleMs: 0 });
  assert.equal(r.status, "all_dismissed");
  assert.equal(r.actions[0].control?.intent, "accept");
});

test("the attempt limit leaves remaining overlays recorded", async () => {
  const a = overlay("promotional", "Offer A", [["Close", "close"]]);
  const b = overlay("promotional", "Offer B", [["Dismiss", "close"]], 450);
  const page = new FakePage([a, b], { Close: (p) => p.remove(a.label), Dismiss: (p) => p.remove(b.label) });
  const r = await dismissOverlays(page, { method: "click", settleMs: 0, maxActions: 1 });
  assert.equal(r.status, "partially_dismissed");
  assert.deepEqual(page.presses, ["Close"]);
  assert.deepEqual(r.actions.map((x) => x.outcome), ["dismissed", "attempt_limit_reached"]);
  assert.deepEqual(r.remainingOverlays.map((o) => o.label), ["Offer B"]);
});

test("capture states keep the initial viewport first and unaltered", async () => {
  const promo = overlay("promotional", "Get 15% off", [["×", "close"]]);
  const page = new FakePage([promo], { "×": (p) => p.remove(promo.label) });
  const r = await dismissOverlays(page, { method: "tap", settleMs: 0 });
  const states = buildCaptureStates(r, { path: "run/x/pdp_1-mobile.png", at: "t1" }, { path: "run/x/pdp_1-mobile-unobstructed.png", at: "t2" });

  assert.deepEqual(states.map((s) => s.state), ["initial_viewport", "after_overlay_dismissal"]);
  assert.equal(states[0].screenshot_path, "run/x/pdp_1-mobile.png");
  assert.equal(states[0].overlays_visible[0].label, "Get 15% off");
  assert.equal(states[0].actions, undefined, "the initial state records no actions");
  assert.match(states[0].note, /Unmodified/);
  assert.equal(states[1].screenshot_path, "run/x/pdp_1-mobile-unobstructed.png");
  assert.equal(states[1].dismissal_status, "all_dismissed");
  assert.deepEqual(states[1].overlays_visible, []);
  assert.equal(states[1].actions?.[0].control?.label, "×");
  assert.ok(JSON.parse(JSON.stringify(states)), "states are plain JSON for storage");
});
