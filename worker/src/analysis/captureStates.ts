/** The one vocabulary for capture states, shared by analyst, verifier and (mirrored in src/lib/captureStates.ts) the review page. */
export const CAPTURE_STATE_TERMS = {
  initial_viewport: {
    label: "First load, as served",
    meaning: "the screen exactly as it first loaded, before any interaction; pop-ups and banners may cover the page",
  },
  after_overlay_dismissal: {
    label: "First clear view, after closing pop-ups",
    meaning: "the same screen after automated close or decline presses (never accept); it is NOT the first thing a visitor sees",
  },
  full_page_section: {
    label: "Full-page section",
    meaning: "a slice of the full-length page captured after closing pop-ups, with its pixel range",
  },
  extracted_text: {
    label: "Page text",
    meaning: "text extracted from the page during the same session",
  },
} as const;

export type CaptureStateKey = keyof typeof CAPTURE_STATE_TERMS;

export function captureStateLabel(state: string): string {
  return CAPTURE_STATE_TERMS[state as CaptureStateKey]?.label ?? state.replace(/_/g, " ");
}

export function captureStateGlossary(): string {
  return Object.values(CAPTURE_STATE_TERMS)
    .map((t) => `- "${t.label}": ${t.meaning}.`)
    .join("\n");
}
