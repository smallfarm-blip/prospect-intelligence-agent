/** Mirrors worker/src/analysis/captureStates.ts so reviewers and models use the same words. */
export const CAPTURE_STATE_TERMS: Record<string, { label: string; meaning: string }> = {
  initial_viewport: {
    label: 'First load, as served',
    meaning: 'The screen exactly as it first loaded, before any interaction; pop-ups and banners may cover the page',
  },
  after_overlay_dismissal: {
    label: 'First clear view, after closing pop-ups',
    meaning: 'The same screen after automated close or decline presses (never accept); it is not the first thing a visitor sees',
  },
  full_page_section: {
    label: 'Full-page section',
    meaning: 'A slice of the full-length page captured after closing pop-ups',
  },
  extracted_text: {
    label: 'Page text',
    meaning: 'Text extracted from the page during the same session',
  },
};

export function captureStateLabel(state: string): string {
  return CAPTURE_STATE_TERMS[state]?.label ?? state.replace(/_/g, ' ');
}
