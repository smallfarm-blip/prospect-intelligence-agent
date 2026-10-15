/*
# Add overlay capture states to page evidence

## Plain-English summary
Each page capture now records two states per viewport:
1. `initial_viewport`: the untouched first-visit screenshot (existing `screenshot_path`,
   unchanged and never modified).
2. `after_overlay_dismissal`: a second viewport screenshot taken after the worker tried to
   close consent banners and promotional pop-ups using their own visible buttons.
The overlays found, the control used, how it was activated and whether it worked are stored
alongside the capture, so later analysis can tell first-visit friction apart from the
underlying shopping page.

## 1. Modified tables
- `page_evidence`
  - `unobstructed_screenshot_path` (text, nullable): storage path of the post-dismissal viewport screenshot.
  - `overlay_dismissal_status` (text, nullable): none_detected, all_dismissed, partially_dismissed,
    not_dismissed, navigated_away, error. Null when the page was not captured.
  - `capture_states` (jsonb, default '[]'): ordered list of captured states with labels,
    screenshot paths, timestamps, overlays observed, and dismissal actions with outcomes.

## 2. Security
- No policy or privilege changes. The table stays private (RLS on, no client policies,
  anon/authenticated privileges revoked); new columns inherit that.

## 3. Important notes
1. Additive only; existing rows and columns are untouched.
2. Overlays are never hidden with CSS or removed from the page; only visible controls are used.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'page_evidence' AND column_name = 'unobstructed_screenshot_path') THEN
    ALTER TABLE page_evidence ADD COLUMN unobstructed_screenshot_path text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'page_evidence' AND column_name = 'overlay_dismissal_status') THEN
    ALTER TABLE page_evidence ADD COLUMN overlay_dismissal_status text
      CHECK (overlay_dismissal_status IN ('none_detected', 'all_dismissed', 'partially_dismissed', 'not_dismissed', 'navigated_away', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'page_evidence' AND column_name = 'capture_states') THEN
    ALTER TABLE page_evidence ADD COLUMN capture_states jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS page_evidence_overlay_status_idx ON page_evidence (research_run_id, overlay_dismissal_status);

REVOKE ALL ON page_evidence FROM anon, authenticated;
