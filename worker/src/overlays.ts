export type OverlayKind = "consent" | "promotional" | "other";
export type ControlIntent = "close" | "decline" | "accept";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayControl {
  label: string;
  intent: ControlIntent;
  tag: string;
  /** Centre point in page viewport coordinates. */
  x: number;
  y: number;
  /** True when the control is the topmost element at its centre, i.e. a visitor could press it. */
  hitTestOk: boolean;
}

export interface DetectedOverlay {
  kind: OverlayKind;
  label: string;
  tag: string;
  isFrame: boolean;
  frameUrl: string | null;
  coverage: number;
  box: Box;
  controls: OverlayControl[];
}

export interface OverlaySummary {
  kind: OverlayKind;
  label: string;
  tag: string;
  isFrame: boolean;
  frameUrl: string | null;
  coverage: number;
  box: Box;
  controlsFound: Array<{ label: string; intent: ControlIntent; pressable: boolean }>;
}

export type DismissalOutcome =
  | "dismissed"
  | "still_visible"
  | "navigated_away"
  | "no_dismiss_control_found"
  | "control_obscured"
  | "attempt_limit_reached";

export interface DismissalAction {
  overlay: OverlaySummary;
  firstSeen: "initial" | "later";
  control: { label: string; intent: ControlIntent; tag: string } | null;
  method: "click" | "tap" | null;
  outcome: DismissalOutcome;
  detail: string;
}

export type DismissalStatus = "none_detected" | "all_dismissed" | "partially_dismissed" | "not_dismissed" | "navigated_away" | "error";

export interface DismissalResult {
  status: DismissalStatus;
  initialOverlays: OverlaySummary[];
  actions: DismissalAction[];
  remainingOverlays: OverlaySummary[];
  error: string | null;
}

/** What the dismissal routine needs from a browser page; real and fake implementations exist. */
export interface OverlayDriver {
  scan(): Promise<DetectedOverlay[]>;
  activate(x: number, y: number): Promise<void>;
  currentUrl(): string;
  wait(ms: number): Promise<void>;
}

const INTENT_ORDER: Record<OverlayKind, ControlIntent[]> = {
  // Prefer refusing optional tracking; accept is the last resort for consent only.
  consent: ["decline", "close", "accept"],
  promotional: ["close", "decline"],
  other: ["close", "decline"],
};

export function summarize(o: DetectedOverlay): OverlaySummary {
  return {
    kind: o.kind,
    label: o.label,
    tag: o.tag,
    isFrame: o.isFrame,
    frameUrl: o.frameUrl,
    coverage: o.coverage,
    box: o.box,
    controlsFound: o.controls.map((c) => ({ label: c.label, intent: c.intent, pressable: c.hitTestOk })),
  };
}

export function chooseControl(o: DetectedOverlay): OverlayControl | null {
  for (const intent of INTENT_ORDER[o.kind]) {
    const control = o.controls.find((c) => c.intent === intent && c.hitTestOk);
    if (control) return control;
  }
  return null;
}

function overlapRatio(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const union = a.width * a.height + b.width * b.height - w * h;
  return union > 0 ? (w * h) / union : 0;
}

/** Same overlay across scans: same element type and kind, and either the same text or nearly the same area. */
export function sameOverlay(a: DetectedOverlay | OverlaySummary, b: DetectedOverlay | OverlaySummary): boolean {
  if (a.kind !== b.kind || a.tag !== b.tag) return false;
  if (a.label && b.label && a.label.slice(0, 60) === b.label.slice(0, 60)) return true;
  return overlapRatio(a.box, b.box) > 0.8;
}

function statusOf(initial: DetectedOverlay[], actions: DismissalAction[], remaining: DetectedOverlay[]): DismissalStatus {
  if (!initial.length && !actions.length) return "none_detected";
  if (!remaining.length) return "all_dismissed";
  return actions.some((a) => a.outcome === "dismissed") ? "partially_dismissed" : "not_dismissed";
}

/**
 * Tries to clear overlays the way a visitor would: by pressing a visible close, decline or
 * consent control that is actually on top at its position. Never hides or removes elements.
 * Each overlay gets one attempt; anything left is recorded with the reason.
 */
export async function dismissOverlays(
  driver: OverlayDriver,
  opts: { method: "click" | "tap"; settleMs?: number; maxActions?: number },
): Promise<DismissalResult> {
  const settleMs = opts.settleMs ?? 1200;
  const maxActions = opts.maxActions ?? 6;
  const startUrl = driver.currentUrl();
  const initial = await driver.scan();
  const firstSeen = (o: DetectedOverlay) => (initial.some((i) => sameOverlay(i, o)) ? "initial" : "later");
  const actions: DismissalAction[] = [];
  const settled: DetectedOverlay[] = [];
  const isSettled = (o: DetectedOverlay) => settled.some((s) => sameOverlay(s, o));
  let current = initial;
  let attempts = 0;

  while (true) {
    const open = current.filter((o) => !isSettled(o));
    if (!open.length) break;
    const target = open.find((o) => chooseControl(o));

    if (!target || attempts >= maxActions) {
      for (const o of open) {
        const blocked = o.controls.some((c) => INTENT_ORDER[o.kind].includes(c.intent));
        const outcome: DismissalOutcome = target ? "attempt_limit_reached" : blocked ? "control_obscured" : "no_dismiss_control_found";
        const detail =
          outcome === "attempt_limit_reached"
            ? `Stopped after ${maxActions} dismissal attempts`
            : outcome === "control_obscured"
              ? "A dismiss control exists but another layer covers it, so a visitor could not press it"
              : "No visible close, decline or consent control was found; the overlay was left in place";
        actions.push({ overlay: summarize(o), firstSeen: firstSeen(o), control: null, method: null, outcome, detail });
        settled.push(o);
      }
      break;
    }

    const control = chooseControl(target)!;
    attempts++;
    await driver.activate(control.x, control.y);
    await driver.wait(settleMs);
    const action: DismissalAction = {
      overlay: summarize(target),
      firstSeen: firstSeen(target),
      control: { label: control.label, intent: control.intent, tag: control.tag },
      method: opts.method,
      outcome: "dismissed",
      detail: "",
    };

    if (driver.currentUrl() !== startUrl) {
      actions.push({ ...action, outcome: "navigated_away", detail: `Pressing the control loaded ${driver.currentUrl()}; later state is not the original page` });
      return { status: "navigated_away", initialOverlays: initial.map(summarize), actions, remainingOverlays: [], error: null };
    }

    let after = await driver.scan();
    if (after.some((o) => sameOverlay(o, target))) {
      await driver.wait(settleMs);
      after = await driver.scan();
    }
    if (after.some((o) => sameOverlay(o, target))) {
      action.outcome = "still_visible";
      action.detail = "Overlay was still visible after pressing the control; no further attempts made on it";
      settled.push(target);
    } else {
      action.detail = "Overlay no longer visible after pressing the control";
    }
    actions.push(action);
    current = after;
  }

  return {
    status: statusOf(initial, actions, current),
    initialOverlays: initial.map(summarize),
    actions,
    remainingOverlays: current.map(summarize),
    error: null,
  };
}

export interface CaptureState {
  state: "initial_viewport" | "after_overlay_dismissal";
  screenshot_path: string | null;
  captured_at: string | null;
  overlays_visible: OverlaySummary[];
  dismissal_status?: DismissalStatus;
  actions?: DismissalAction[];
  error?: string | null;
  note: string;
}

const AFTER_NOTES: Record<DismissalStatus, string> = {
  none_detected: "No overlays were detected, so nothing was pressed; this screenshot shows the same page moments later. Detection is heuristic, so review the initial screenshot too.",
  all_dismissed: "Every detected overlay was closed with its own visible control.",
  partially_dismissed: "Some overlays were closed; the rest are listed in overlays_visible with the reason they remain.",
  not_dismissed: "No detected overlay could be closed with a visible control; overlays_visible lists what remains and why.",
  navigated_away: "Pressing an overlay control loaded a different page, so no post-dismissal screenshot of the original page exists.",
  error: "Overlay dismissal failed with an error; see error.",
};

/** Describes both capture states for storage; the initial state is always first and unaltered. */
export function buildCaptureStates(
  dismissal: DismissalResult,
  initial: { path: string | null; at: string | null },
  after: { path: string | null; at: string | null },
): CaptureState[] {
  return [
    {
      state: "initial_viewport",
      screenshot_path: initial.path,
      captured_at: initial.at,
      overlays_visible: dismissal.initialOverlays,
      note: "Unmodified first-visit viewport. Overlays listed were found by a read-only scan immediately after this screenshot.",
    },
    {
      state: "after_overlay_dismissal",
      screenshot_path: after.path,
      captured_at: after.at,
      overlays_visible: dismissal.remainingOverlays,
      dismissal_status: dismissal.status,
      actions: dismissal.actions,
      error: dismissal.error,
      note: AFTER_NOTES[dismissal.status],
    },
  ];
}
