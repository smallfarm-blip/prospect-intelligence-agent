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
7. Verifies the stored evidence, then writes `report.html`, `report.md` and `report.json` to the run folder,
   points `output/latest` at it and refreshes `output/index.html`.

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
  SMS pop-ups) and classifies them as `consent`, `promotional` or `other`. Known cookie-banner containers
  (OneTrust, Cookiebot, Shopify's privacy banner and similar) are found wherever they are positioned, as are
  banners inside zero-size fixed wrappers or open shadow roots. A container holding both a promo and a
  cookie banner is reported as two overlays.
- Only real, visible controls are used, pressed with a real click (desktop) or tap (mobile) at the control's
  position. A control is pressed only if it is actually on top at that point; if another layer covers it,
  it is recorded as `control_obscured` and left alone.
- Order of preference: for consent, decline / reject / "necessary only", then close; for promotions,
  close, then "no thanks". **Accept is never pressed**, so optional cookies are never accepted
  automatically: a banner that only offers accept is left in place and recorded as `accept_only`. Sign-up,
  subscribe, settings and similar buttons are never pressed.
- Nothing is hidden or removed with CSS or scripts, and no access restriction is bypassed.
- Each overlay gets one attempt, and the page is rescanned after every attempt. When nothing seems left, the
  worker waits and rescans once more, so overlays that appear late (or were hidden behind another one) are
  handled or reported. The status comes from that final rescan: `all_dismissed` only if it finds nothing;
  if anything remains it is `partially_dismissed` (something was closed) or `not_dismissed`.
- If a control loads a different page, the worker stops and records `navigated_away` (no unobstructed
  screenshot exists in that case). In every other case, including partial and failed dismissal, both the
  initial and after-dismissal screenshots are kept.

Stored in `page_evidence`:

- `overlay_dismissal_status`: `none_detected`, `all_dismissed`, `partially_dismissed`, `not_dismissed`,
  `navigated_away` or `error`.
- `capture_states`: a list of exactly two entries, `initial_viewport` first. Each lists its screenshot, timestamp
  and the overlays visible in it. The second also has `overlays_removed` (closed by a pressed control) and
  `overlays_visible` (still found by the final rescan), and lists every action: which overlay, whether it was
  there at first or appeared later, which control was pressed and how, and the outcome (`dismissed`,
  `still_visible`, `navigated_away`, `control_obscured`, `accept_only`, `no_dismiss_control_found`,
  `attempt_limit_reached`).

The report shows both screenshots per page and, for each, which overlays were removed and which are still
visible. Overlays that could not be closed are listed as review warnings. Dismissal adds a few seconds per viewport to session time (and so to
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

Start with **`worker/output/index.html`**. It lists every run, newest first, with status, sites, pages
captured and estimated cost, and links to each report. **`worker/output/latest/report.html`** always opens the
most recent finished run.

```
output/
  index.html                          all runs
  latest -> 2026-10-15_14-03-22Z_a91d77f0   shortcut (no copied files)
  2026-10-15_14-03-22Z_a91d77f0/       one folder per run: UTC start time + first 8 chars of the run ID
    report.html  report.md  report.json  worker.log.jsonl
    screenshots/
      kosas.com/
        homepage/  plp/  pdp-1/  pdp-2/  plp-candidate-1/ ...
          desktop-initial.png  desktop-after-dismissal.png  desktop-full-page.jpg
          mobile-initial.png   mobile-after-dismissal.png   mobile-full-page.jpg
  3f2b9c1e-...-000000000001/            older runs keep their original UUID folder, unchanged
```

In each run folder:

- `report.html` — standalone page (open it in any browser, works offline):
  - summary of pages captured, estimated cost, checks and overlay outcomes;
  - coverage, verification checks and warnings, and the cost breakdown;
  - one card per page with desktop and mobile side by side. Each shows the initial and after-dismissal
    screenshots (click to open full size), the capture and overlay status, and every dismissal action.
- `report.md` — the same summary as Markdown, with signed Storage links that expire after 7 days.
- `report.json` — the same data, machine-readable. Each capture lists both its Storage paths and its
  `localScreenshots`.
- `screenshots/` — local copies, grouped by company and page.
- `worker.log.jsonl` — structured operational log (one JSON event per line).

Notes:

- The full run UUID is still the ID used everywhere in Supabase and appears in every report. Only the
  local folder name is shortened.
- `latest` moves only after a run writes its reports. A run that aborts early keeps its folder and appears in
  the index as "no report". `latest` stays on the previous finished run.
- `latest` is a symbolic link (a directory junction on Windows). If it can't be created, or a real folder
  named `latest` already exists, the worker leaves it alone and prints a note. The index still links every run.
- Older UUID-named folders are listed in the index but never modified, so their screenshots keep their
  original flat names and only `report.md` is available for them.
- Storage paths are unchanged, so existing database records and links stay valid.

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
   A page marked `all_dismissed` or `none_detected` must have no overlays left in its after-dismissal state.

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
- Cookies are never accepted, so on sites whose banner has no reject or close control the after-dismissal
  screenshot still shows the banner (`partially_dismissed` or `not_dismissed`). Declining cookies can still
  change what loads afterwards; the action is recorded so the after state can be read with that in mind.
- One worker process at a time is the tested configuration, although job claiming is safe for several.

---

# Phase 1: evidence-backed opportunity analysis

Phase 1 reads evidence already stored by Phase 0 and never visits a website. It produces 0 to 5 opportunity hypotheses per run, each independently verified, and stores everything for review in the web app.

## How an analysis run works

1. **Evidence loader** pulls the research run's pages, screenshots (initial, after overlay dismissal, full-page sections) and page text from Supabase, and prepares model-sized images. Derived images are uploaded to `analysis/<analysis_run_id>/` in the private screenshot bucket.
2. **Analyst** (one call) receives all evidence and returns findings in a fixed structure that separates observed facts, hypothesis, commercial relevance and measurement. Zero findings is a valid result. Invalid output is retried once.
3. **Automatic checks** run on each finding: cited references exist, quotes match page text, no invented outcome figures, overlay claims agree with the screenshots and metadata. A blocker rejects the finding without a model call.
4. **Verifier** (one call per finding, separate prompt) sees only the finding's claims and the evidence they cite, and judges each claim.
5. **Optional revision** (`--revise`): a finding marked "needs revision" gets one rewrite attempt, stored as a new linked finding and re-verified.

## Budget

The budget (default $2.50) is enforced before each call: the worst-case cost of the call (provider-counted input tokens plus a margin, plus the maximum output tokens) must fit in what remains, otherwise the call is refused and the run ends as `stopped_budget`. If a call fails in a way where billing is unknown (timeout, network error, server error, malformed reply), its worst case is counted as spent. Costs shown are estimates from provider-reported token usage and configured prices, not billing; check each provider's billing dashboard for billed amounts. The run record keeps reported-usage cost and the worst-case amounts reserved for unknown-billing calls separately.

Token counting before each call: Anthropic and OpenAI both count with the provider. If OpenAI cannot count tokens for the configured model, a local estimate padded by 1.5x is used instead (labelled "local estimate" in the call log), and the normal margin is added on top. OpenAI reasoning tokens are billed as output and count toward the output limit, so they are already inside the worst case.

## Providers and models

Analyst and verifier are configured independently (`ANALYST_*`, `VERIFIER_*`; see `.env.example`). Revision calls use the analyst's settings. Supported providers:

| Provider | Default model | Structured output | Images |
|---|---|---|---|
| `anthropic` | `claude-sonnet-5-5` | one forced tool call | prepared JPEG, sent as-is |
| `openai` | `gpt-6-sol` | one forced strict function call (Responses API, `store: false`) | prepared JPEG with configurable `*_IMAGE_DETAIL` (default `high`) |

OpenAI strict mode accepts a subset of JSON Schema. The converter closes every object and requires every field (our schemas have no optional fields, only nullable ones) and drops keywords strict mode does not support, such as text length limits. Every reply is still validated locally against the full schema and the automatic checks, so validation is unchanged.

Prompts, evidence selection, checks and limits are identical for both providers. Mixed analyst/verifier providers are supported but not part of the pilot.

Settings profiles in `config/` hold model choices only (they refuse API keys):

- `config/analysis-openai.env`: GPT-6 Sol analyst + GPT-6 Sol verifier
- `config/analysis-anthropic.env`: Claude Sonnet 5.5 analyst + Claude Sonnet 5.5 verifier

## Commands

```bash
cd worker
npm run analyse -- --run 7db7f203 --company kosas.com            # free dry run: loads evidence, prints the plan and worst-case cost, writes nothing
npm run analyse -- --run 7db7f203 --company kosas.com --live     # paid analysis
npm run analyse -- --run 7db7f203 --company kosas.com --live --revise

# Provider comparison pilot: same evidence, prompts and limits
npm run analyse -- --run 7db7f203 --company kosas.com --settings config/analysis-openai.env              # free dry run
npm run analyse -- --run 7db7f203 --company kosas.com --settings config/analysis-anthropic.env           # free dry run
npm run analyse -- --run 7db7f203 --company kosas.com --settings config/analysis-openai.env --live       # paid
npm run analyse -- --run 7db7f203 --company kosas.com --settings config/analysis-anthropic.env --live    # paid
```

`--run` accepts a full research run ID or its first 8 characters. Logs go to `output/analysis/`.

Pilot: research run `7db7f203`. Regression: research run `d1408822`, where a cookie banner stayed visible although the record said overlays were dismissed. The automated tests cover this case with fixtures; no rescan is needed.

## Reviewer access

1. Open the web app and create an account.
2. The app shows your account ID. Add it to the allowlist in the Supabase SQL editor:
   `insert into reviewers (user_id, note) values ('<account id>', 'owner');`
3. Reload. Reviewers can read analysis results and screenshots and record approve / reject (with reason) / revise decisions. Nobody else, and no signed-out visitor, can read anything.

## Finding format v1.1: maturity, priority and outreach readiness

Findings produced from now on carry `schema_version = finding-v1.1` (prompts `analyst-v1.1`, `verifier-v1.1`, `revision-v1.1`). Earlier findings, including the first Kosas pilot (`f29a764c`), are unchanged and shown as "Earlier format" in the review app.

**Three separate dimensions, never derived from one another:**

| Dimension | Values | Who sets it |
|---|---|---|
| Evidence maturity (`finding_class`) | `evidence_backed_opportunity`, `research_hypothesis`, `low_value_observation` | Analyst proposes; system may only lower it after verification; reviewer may change it |
| Investigation priority | `high`, `medium`, `low` from commercial/RPV relevance, decision importance, hypothesis strength and effort to resolve unknowns | Analyst proposes; verifier recommends; reviewer may change it |
| Outreach readiness | `not_ready`, `exploratory`, `ready` | Reviewers only. Nothing is ever set automatically |

A research hypothesis can be high priority. Findings are listed in analysis order unless the reviewer picks a sort.

**System class assignment** (`src/analysis/assessment.ts`) only lowers the class: capped at the verifier's recommendation; `low_value_observation` if generic or not a meaningful decision; `research_hypothesis` if existing site support was not considered, there are critical gaps, the evidence is not fully supported, or any critical unknown `could_invalidate` the finding. Priority is the verifier's recommendation, else the analyst's.

**Evidence verification vs opportunity quality.** The verifier returns `evidence_verdict` (strict factual check) and a separate `opportunity_assessment`. `evidence_status` is computed from blocker/revision checks, claim verdicts and `evidence_verdict`; the overall `status` is the stricter combination. Opportunity judgements never soften evidence failures.

**New finding fields:** fact `page_ref` + `device`, `behavioral_inferences` (with basis facts), `existing_site_support`, `problem_type` (friction vs decision complexity), structured `critical_unknowns` (severity, how to resolve, effort), optional cross-page `journey`, `rpv_pathway` (levers and mechanism; no figures), `investigation_priority` breakdown.

**New automatic checks** (`src/analysis/structureChecks.ts`): page attribution and device (blocker); shared-screenshot page identity, capture-state wording ("first load" vs "first clear view, after closing pop-ups"), cookie/consent and promo kept as separate facts, fact links, journey and page scope (revision). Byte-identical screenshots are stored once with `also_captured_for_evidence_ids`, and each finding link records `page_ref` and `attribution` (`direct` or `identical_capture`).

**Reviewer controls (database-enforced):**

- `finding_assessment_overrides`: append-only changes to class or priority with a required reason (10+ characters). The previous effective value is filled in by the database; rows cannot be edited or deleted. The system values stay on the finding and verification records.
- `outreach_readiness_decisions`: append-only. Every finding is Not ready until a reviewer records otherwise. `ready` requires the effective class to be `evidence_backed_opportunity`; `exploratory` requires `evidence_backed_opportunity` or `research_hypothesis` plus `uncertainty_confirmed` (outreach states uncertainty and claims no proven friction or revenue loss). Both approvals also require `proposed_wording` (40 to 2000 characters, stored for later evaluation of outreach angles) and three confirmations: relevant to a Head of eCommerce or similar decision-maker, grounded in this finding's evidence, and no overstatement of friction or impact. Not ready must carry no wording.
- Outreach approval is a record only. Nothing in this system generates, sends or schedules prospect messages.
- Sorting and filtering in the review app use the latest reviewer value; the system values and full history are always shown.
- Reviewers cannot write to evidence, automatic checks, claim checks or verifier results.
- `effective_assessment(finding_id, field)` returns latest reviewer change, else system assignment, else analyst proposal.

## Tests

`npm test` runs Phase 0 and Phase 1 tests with mocked model responses (no network, no cost). `npm run typecheck` checks types.
