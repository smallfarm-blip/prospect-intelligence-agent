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
  | "accept_only"
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
  /** Overlays closed by a pressed control and absent from the final verification scan. */
  removedOverlays: OverlaySummary[];
  /** Everything the final verification scan still found on screen. */
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
  // Accept is never pressed: the collector must not opt the session into optional cookies.
  consent: ["decline", "close"],
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
 * Tries to clear overlays the way a visitor would: by pressing a visible close or decline
 * control that is actually on top at its position. Never hides or removes elements and never
 * accepts cookies. Each overlay gets one attempt; after the last one the page is rescanned once
 * more so overlays that appear late or were missed are reported as remaining.
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
  let verified = false;
  let verifications = 0;

  while (true) {
    const open = current.filter((o) => !isSettled(o));
    if (!open.length) {
      if (verified || verifications > maxActions) break;
      await driver.wait(settleMs);
      current = await driver.scan();
      verified = true;
      verifications++;
      continue;
    }
    const target = open.find((o) => chooseControl(o));

    if (!target || attempts >= maxActions) {
      for (const o of open) {
        const outcome = target ? "attempt_limit_reached" : unpressableOutcome(o);
        actions.push({ overlay: summarize(o), firstSeen: firstSeen(o), control: null, method: null, outcome, detail: OUTCOME_DETAIL[outcome](maxActions) });
        settled.push(o);
      }
      verified = false;
      continue;
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
      return { status: "navigated_away", initialOverlays: initial.map(summarize), actions, removedOverlays: [], remainingOverlays: [], error: null };
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
    verified = false;
  }

  const removed = actions.filter((a) => a.outcome === "dismissed" && !current.some((o) => sameOverlay(o, a.overlay))).map((a) => a.overlay);
  return {
    status: statusOf(initial, actions, current),
    initialOverlays: initial.map(summarize),
    actions,
    removedOverlays: removed,
    remainingOverlays: current.map(summarize),
    error: null,
  };
}

type UnpressableOutcome = "attempt_limit_reached" | "control_obscured" | "accept_only" | "no_dismiss_control_found";

function unpressableOutcome(o: DetectedOverlay): UnpressableOutcome {
  if (o.controls.some((c) => INTENT_ORDER[o.kind].includes(c.intent))) return "control_obscured";
  if (o.kind === "consent" && o.controls.some((c) => c.intent === "accept")) return "accept_only";
  return "no_dismiss_control_found";
}

const OUTCOME_DETAIL: Record<UnpressableOutcome, (maxActions: number) => string> = {
  attempt_limit_reached: (n) => `Stopped after ${n} dismissal attempts`,
  control_obscured: () => "A close or decline control exists but another layer covers it, so a visitor could not press it",
  accept_only: () => "Only an accept control was found. Optional cookies are never accepted automatically, so the banner was left in place",
  no_dismiss_control_found: () => "No visible close or decline control was found; the overlay was left in place",
};

export interface CaptureState {
  state: "initial_viewport" | "after_overlay_dismissal";
  screenshot_path: string | null;
  captured_at: string | null;
  overlays_visible: OverlaySummary[];
  /** After-dismissal state only: overlays a pressed control closed. Absent on rows recorded before this field existed. */
  overlays_removed?: OverlaySummary[];
  dismissal_status?: DismissalStatus;
  actions?: DismissalAction[];
  error?: string | null;
  note: string;
}

const AFTER_NOTES: Record<DismissalStatus, string> = {
  none_detected: "No overlays were detected, so nothing was pressed; this screenshot shows the same page moments later. Detection is heuristic, so review the initial screenshot too.",
  all_dismissed: "Every detected overlay was closed with its own visible control, and a final rescan found none remaining.",
  partially_dismissed: "Some overlays were closed (overlays_removed); a final rescan still found the ones in overlays_visible, so this screenshot is not fully unobstructed.",
  not_dismissed: "No detected overlay could be closed with a visible close or decline control; overlays_visible lists what remains and actions say why.",
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
      overlays_removed: dismissal.removedOverlays,
      dismissal_status: dismissal.status,
      actions: dismissal.actions,
      error: dismissal.error,
      note: AFTER_NOTES[dismissal.status],
    },
  ];
}

/** Overlays the after-dismissal state records as closed; older rows only have the actions to go on. */
export function removedIn(after: CaptureState): OverlaySummary[] {
  return after.overlays_removed ?? (after.actions ?? []).filter((a) => a.outcome === "dismissed").map((a) => a.overlay);
}
