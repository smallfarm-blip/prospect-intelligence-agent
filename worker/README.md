# Prospect research worker — Phase 0 evidence-acquisition spike

A standalone Node.js/TypeScript worker that opens real eCommerce sites in a remote browser
(Browserless, via `playwright-core`). It captures the homepage, one listing page (PLP) and two product
pages (PDPs) at desktop and mobile sizes. Every capture, or recorded non-capture, is stored in Supabase.

Phase 0 collects evidence only. It does **no** AI analysis, scoring, contact research, outreach or
scheduling, and nothing in its output should be read as a judgement about a site.

## How a run works

1. Loads and validates settings (`.env`) and the site list (`config/spike-sites.json`).
2. Checks Supabase access, creates a `research_runs` row and one `research_jobs` row per site.
3. Claims jobs atomically (`claim_next_job`, which uses `FOR UPDATE SKIP LOCKED`), so two workers never
   process the same site.
4. For each site:
   - fetches `robots.txt` (RFC 9309);
   - captures the homepage;
   - discovers PLP candidates from the homepage links, accepting the first one that loads and contains product links;
   - picks two PDPs from the PLP (falling back to homepage links, then to the URLs in the config file);
   - captures each page at desktop (1440x900) and mobile (390x844, iPhone UA).
5. One Browserless session is used per page, covering both viewports. It is opened only if the
   worst-case cost still fits under the run ceiling.
6. Each viewport capture is written to `page_evidence` and stored in a private bucket
   (`evidence-screenshots`): two viewport PNGs (see "Capture states" below), full-page JPEG, URL, final URL,
   timestamp, HTTP status, title, visible text (first 20k chars + SHA-256 of the full text), and page-type signals.
7. Verifies the stored evidence, then writes `output/<run-id>/report.md` and `report.json`.

Sites that block automated access are recorded as `blocked` with the reason. The worker does not try
to get around blocks, CAPTCHAs or `robots.txt` rules.

## Capture states (overlays)

Every captured page, at both desktop and mobile, is recorded in two states so the analysis can separate
first-visit friction from the underlying shopping experience:

| State | File | What it shows |
| --- | --- | --- |
| `initial_viewport` | `<slot>-<viewport>.png` (`screenshot_path`) | Exactly what a first-time visitor sees after load, overlays included. Taken before any interaction and never modified. |
| `after_overlay_dismissal` | `<slot>-<viewport>-unobstructed.png` (`unobstructed_screenshot_path`) | The same viewport after the worker tried to close consent and promotional overlays. |

The full-page JPEG is taken after the dismissal attempt (`page_type_signals.fullPageState`).

How dismissal works:

- A read-only scan finds fixed, sticky or dialog layers in the viewport (including sign-up iframes such as
  SMS pop-ups) and classifies them as `consent`, `promotional` or `other`.
- Only real, visible controls are used, pressed with a real click (desktop) or tap (mobile) at the control's
  position. A control is pressed only if it is actually on top at that point; if another layer covers it,
  it is recorded as `control_obscured` and left alone.
- Order of preference: for consent, decline / reject, then close, and accept only as a last resort; for
  promotions, close, then "no thanks". Sign-up, subscribe, settings and similar buttons are never pressed.
- Nothing is hidden or removed with CSS or scripts, and no access restriction is bypassed.
- Each overlay gets one attempt. If a control loads a different page, the worker stops and records
  `navigated_away` (no unobstructed screenshot exists in that case).

Stored in `page_evidence`:

- `overlay_dismissal_status`: `none_detected`, `all_dismissed`, `partially_dismissed`, `not_dismissed`,
  `navigated_away` or `error`.
- `capture_states`: a list of exactly two entries, `initial_viewport` first. Each lists its screenshot, timestamp
  and the overlays visible in it. The second also lists every action: which overlay, whether it was there at
  first or appeared later, which control was pressed and how, and the outcome (`dismissed`, `still_visible`,
  `navigated_away`, `control_obscured`, `no_dismiss_control_found`, `attempt_limit_reached`).

The report shows both screenshots per page and an "Overlays" section per site. Overlays that could not be
closed are listed as review warnings. Dismissal adds a few seconds per viewport to session time (and so to
the cost estimate).

## Selected test sites

| Category | Brand | Domain |
| --- | --- | --- |
| Apparel | Taylor Stitch | taylorstitch.com |
| Beauty | Kosas | kosas.com |
| Home goods | Parachute | parachutehome.com |

These are well-known US DTC brands, picked so the spike exercises three different catalog layouts.
They were **not** assessed for ICP fit. Change them in `config/spike-sites.json`; jewelry categories
are rejected. `fallback.plp` / `fallback.pdps` are empty on purpose. Fill them in only if automatic
discovery fails for a site, and the report will mark those pages as `manual_fallback`.

## Before the first real run: what you must configure

### 1. Browserless

1. Create an account at browserless.io. The free plan is enough for the spike.
2. Copy your **API token** from the account dashboard into `BROWSERLESS_TOKEN`.
3. Set `BROWSERLESS_ENDPOINT` to your account's region:
   - `wss://production-sfo.browserless.io` (US West, the default)
   - `wss://production-lon.browserless.io`
   - `wss://production-ams.browserless.io`
4. Plan limits that matter:
   - **Free plan:** 1,000 units/month, sessions capped at 2 minutes, 2 concurrent browsers.
     `BROWSERLESS_SESSION_TIMEOUT_MS=110000` keeps every session under that cap.
   - **Paid plans:** set `BROWSERLESS_UNIT_PRICE_USD` to your plan's per-unit overage price
     (for example `0.002` on Prototyping).

### 2. Supabase (server-side secret key)

The database tables, job-claiming functions and the private screenshot bucket are already created in
this project's database. All tables are private: no anonymous or signed-in client access, with row level
security on and no policies. The worker uses Supabase's **secret key** (`sb_secret_...`), which only belongs
on a trusted machine. It is not the legacy `service_role` JWT, and it must never be a publishable key
(the worker refuses `sb_publishable_...`).

The database Bolt created for this project does not expose its secret key, so you need one of these:

- **Option A — claim the Bolt database (keeps the existing tables).** Requires a Bolt Pro/Teams plan and
  owner rights on your Supabase organisation. In Bolt, click the **Database icon** → **Advanced** →
  **Claim**, then finish the steps in Supabase.
- **Option B — connect a dedicated Supabase project.** In Bolt, click the **Database icon** → **Advanced**
  → **Connect**. Then ask Bolt to re-apply the two Phase 0 database changes
  (`create_evidence_collection_schema`, `create_job_claiming_and_screenshot_storage`) to the new project.

Then, in the Supabase dashboard:

1. **Project Settings → API Keys → Secret keys → Create new secret key** (name it e.g. `research-worker`).
   Copy it into `SUPABASE_SECRET_KEY`.
2. Copy the **Project URL** (`https://<ref>.supabase.co`) into `SUPABASE_URL`.

### 3. Local setup

Requires Node.js 20.6 or later.

```bash
cd worker
cp .env.example .env      # then fill in the three required values
npm install
npm test                  # offline unit tests; no network or credentials needed
```

`.env` is git-ignored. Never commit it or paste the secret key into the web app.

## Running the collector

```bash
npm run collect
```

Progress is printed to the console. When the run finishes, it prints the path to the report. Exit code is
non-zero if the run failed outright. Cost limits are set in `.env`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_RUN_UNITS` | 150 | Hard cap on estimated Browserless units per run |
| `MAX_RUN_COST_USD` | 1.00 | Hard cap on estimated spend per run |
| `RATE_LIMIT_MS` | 4000 | Minimum gap between page loads on the same site (raised to honour `Crawl-delay`) |
| `PAGE_TIMEOUT_MS` | 30000 | Navigation timeout per page |
| `MAX_PLP_CANDIDATES` | 3 | Listing-page candidates tried before giving up |

A full run is 3 sites x (1 homepage + 1-3 PLP candidates + 2 PDPs) sessions. That is typically about
15-25 sessions of 1-2 units each, well inside the defaults.

## Viewing results

Each run writes to `worker/output/<run-id>/`:

- `report.md` — human-readable summary:
  - coverage per site (captured / 8 required);
  - a per-page table with status, final URL, HTTP code, overlay dismissal status and notes;
  - an "Overlays" section per site describing each dismissal action;
  - verification checks and warnings;
  - the cost section;
  - links to every screenshot. Links are signed and expire after 7 days.
- `report.json` — the same data, machine-readable.
- `screenshots/` — local copies of every screenshot.
- `worker.log.jsonl` — structured operational log (one JSON event per line).

The same data is in Supabase:

- `research_runs` — one row per run: status, cost estimate, summary, errors.
- `research_jobs` — one row per site per run.
- `page_evidence` — one row per page per viewport. Filter by `research_run_id` to compare runs.
- Storage bucket `evidence-screenshots` — files under `<run-id>/<domain>/<slot>-<viewport>.png`, plus
  `-unobstructed.png` and `-full.jpg` variants.

### Status meanings

| `access_status` | Meaning |
| --- | --- |
| `captured` | Page loaded and screenshots, text and signals were stored |
| `blocked` | Site returned 401/403/429 or a bot-challenge page; reason in `page_type_signals.blockReason` |
| `timeout` | Page did not load within `PAGE_TIMEOUT_MS` (retried once in a fresh session) |
| `error` | Navigation or browser error; see `error_message` |
| `disallowed_by_robots` | `robots.txt` disallows the URL, so it was not visited |
| `not_observed` | The worker could not find a suitable URL, or did not reach it (e.g. the site was already blocked) |
| `skipped_cost_ceiling` | Not attempted because the next session could have exceeded the run ceiling |

`not_observed` means the worker did not see it, **not** that the page or feature does not exist.
Rejected PLP candidates are kept as `plp_candidate_N` rows, so you can see what was tried.

Run statuses: `completed` (all 24 captures plus all checks passed), `completed_with_failures`,
`stopped_cost_ceiling`, `failed`.

### Verification checks

The report runs five integrity checks:

1. Every capture has URL, timestamp, viewport, screenshot, text hash and user agent.
2. Every screenshot file exists in storage (initial, after-dismissal and full-page).
3. Every non-capture records why.
4. Each site has exactly one record per required page and viewport.
5. Every capture records both states, `initial_viewport` first and pointing at the original screenshot, plus
   a dismissal status and an after-dismissal screenshot (unless the control navigated away or dismissal errored).

It also warns about off-site redirects, about product pages that were identified by URL only (no product
markup or add-to-cart control detected), and about overlays still visible after the dismissal attempt,
controls that navigated away, and dismissal errors. These checks confirm the evidence is complete and traceable. They
do **not** confirm what the pages show; review the screenshots yourself.

## Reading the cost report

Browserless charges **1 unit per 30 seconds of browser session time**, rounded up per connection, so
the number of pages visited doesn't set the cost. The worker measures each session's wall-clock
duration and converts it with that rule:

- **Estimated units / estimated cost** — computed from measured session time. This is an **estimate**,
  labelled as such everywhere it appears.
- **Actual units** — always `null` in Phase 0. Browserless does not report consumption per session to the
  worker. Check real usage on the Browserless account dashboard (usage page) after a run, and compare it with
  the estimate. If they differ significantly, adjust `BROWSERLESS_UNIT_PRICE_USD` or tell us so the formula
  can be corrected.
- **Ceiling** — before opening each session, the worker adds the worst case for that session (killed at the
  session timeout) to the running total. It refuses the session if that would exceed `MAX_RUN_UNITS` or
  `MAX_RUN_COST_USD`. Refused pages are recorded as `skipped_cost_ceiling`.
- **Model cost** — `0`; Phase 0 uses no AI models.
- Per-site and per-session breakdowns are included so you can see where time went.

## Known limitations

- PLP/PDP discovery uses URL patterns plus a "contains product links" check. It is tuned for
  Shopify-style URLs and may need fallback URLs on custom platforms.
- The "two contrasting PDPs" are chosen by position in the listing (first and two-thirds down), not by
  verified product differences.
- Block detection is heuristic. A site could serve a soft block that looks like real content; the
  screenshots are the ground truth.
- Mobile emulation uses viewport, touch and user agent in desktop Chromium. It is not a real iOS device.
- Overlay detection is heuristic (position, dialog roles, wording and known vendor names). An unusual overlay may
  be missed (`none_detected` does not mean the page had none; check the initial screenshot), and a
  non-overlay sticky element could occasionally be listed. Overlays inside closed shadow DOM or cross-origin
  iframes that don't respond in time can't be inspected.
- Accepting cookies (last resort) can change what loads afterwards, such as personalisation or tracking scripts;
  the action is recorded so the after state can be read with that in mind.
- One worker process at a time is the tested configuration, although job claiming is safe for several.
