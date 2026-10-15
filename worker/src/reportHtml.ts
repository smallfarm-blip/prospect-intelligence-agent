import type { CostSummary, LocalImage, RunReportInput } from "./report.ts";
import { removedIn, type OverlaySummary } from "./overlays.ts";
import type { StoredEvidence } from "./store.ts";
import { orderEvidence } from "./verify.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const esc = escapeHtml;

export const HTML_STYLE = `
:root{--ink:#14202b;--muted:#5b6b78;--line:#dfe5ea;--bg:#f5f7f8;--card:#fff;--brand:#0f5f73;
--ok:#1d7a4f;--ok-bg:#e3f4ea;--warn:#8a5a00;--warn-bg:#fdf1d8;--bad:#a8322d;--bad-bg:#fbe5e3;--mut-bg:#eceff2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:1240px;margin:0 auto;padding:32px 24px 64px}a{color:var(--brand)}a:hover{text-decoration:none}
h1,h2,h3{line-height:1.2;margin:0 0 8px;font-weight:600}h1{font-size:28px}h2{font-size:20px;margin-top:40px}h3{font-size:16px}
.hero{padding:8px 0 16px;border-bottom:1px solid var(--line);margin-bottom:24px}.eyebrow{margin:0 0 8px;color:var(--brand);font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.sub{color:var(--muted);font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:16px;overflow-x:auto}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.stat b{display:block;font-size:22px;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.num{text-align:right;white-space:nowrap}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:var(--mut-bg);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}
.page{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:16px}
.page-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:16px}
.vps{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.vp h4{margin:0 0 8px;font-size:14px;font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.shots{display:flex;gap:8px;align-items:flex-start}
.shot{flex:1;min-width:0;display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);text-decoration:none;color:var(--muted);transition:transform .15s ease,box-shadow .15s ease}
.shot:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(20,32,43,.12)}
.shot img{display:block;width:100%;max-height:420px;object-fit:cover;object-position:top}.shot span{display:block;padding:4px 8px;font-size:12px;font-weight:600}
.empty{flex:1;border:1px dashed var(--line);border-radius:8px;padding:24px 8px;text-align:center;color:var(--muted);font-size:12px}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--brand);font-weight:600}
ul.actions{margin:8px 0 0;padding-left:20px}ul.actions li{margin-bottom:4px}
.note{background:var(--mut-bg);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--muted)}
.check{display:flex;gap:8px;align-items:baseline;margin:4px 0}
`;

const ACCESS_TONE: Record<string, string> = { captured: "ok", blocked: "bad", error: "bad", timeout: "warn", not_observed: "warn", disallowed_by_robots: "muted", skipped_cost_ceiling: "muted" };
const OVERLAY_TONE: Record<string, string> = { none_detected: "muted", all_dismissed: "ok", partially_dismissed: "warn", not_dismissed: "bad", navigated_away: "warn", error: "bad" };
const OVERLAY_TEXT: Record<string, string> = {
  none_detected: "no overlays detected",
  all_dismissed: "overlays dismissed",
  partially_dismissed: "partially dismissed",
  not_dismissed: "overlays not dismissed",
  navigated_away: "control navigated away",
  error: "dismissal error",
};

const badge = (tone: string | undefined, text: string) => `<span class="badge ${tone ?? "muted"}">${esc(text)}</span>`;

function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function shot(src: string | null, caption: string, missing: string): string {
  if (!src) return `<div class="empty">${esc(caption)}<br>${esc(missing)}</div>`;
  return `<a class="shot" href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(caption)}" loading="lazy"><span>${esc(caption)}</span></a>`;
}

function overlayDetails(e: StoredEvidence): string {
  const after = e.capture_states?.find((s) => s.state === "after_overlay_dismissal");
  const initial = e.capture_states?.find((s) => s.state === "initial_viewport");
  if (!after || !initial) return "";
  const names = (list: OverlaySummary[]) => list.map((o) => `<b>${esc(o.kind)}</b> “${esc(o.label.slice(0, 80) || o.tag)}”`).join("; ") || "none";
  const outcome = `<ul class="actions"><li>${badge("ok", "removed")} ${names(removedIn(after))}</li><li>${badge(after.overlays_visible.length ? "bad" : "ok", "still visible")} ${names(after.overlays_visible)}</li></ul>`;
  const items = [
    ...(after.actions ?? []).map((a) => {
      const how = a.control ? `${a.method} "${a.control.label}" (${a.control.intent})` : "not pressed";
      return `<li>${badge(a.outcome === "dismissed" ? "ok" : a.outcome === "navigated_away" ? "warn" : "bad", a.outcome.replace(/_/g, " "))} <b>${esc(a.overlay.kind)}</b> “${esc(a.overlay.label.slice(0, 80) || a.overlay.tag)}” (${esc(a.firstSeen)}): ${esc(how)}. <span class="sub">${esc(a.detail)}</span></li>`;
    }),
    ...(after.error ? [`<li>${badge("bad", "error")} ${esc(after.error)}</li>`] : []),
  ];
  const summary = `${initial.overlays_visible.length} overlay(s) at first visit`;
  return `<details${e.overlay_dismissal_status === "none_detected" ? "" : " open"}><summary>${esc(summary)}</summary>
<p class="sub">${esc(after.note)}</p>${e.overlay_dismissal_status === "none_detected" ? "" : outcome}${items.length ? `<ul class="actions">${items.join("")}</ul>` : ""}</details>`;
}

function viewportBlock(e: StoredEvidence, image: LocalImage): string {
  const overlay = e.overlay_dismissal_status;
  const notes = [e.navigation_notes, e.error_message, (e.page_type_signals as { blockReason?: string }).blockReason].filter(Boolean).join(" · ");
  const afterMissing = overlay === "navigated_away" ? "not taken: a control left the page" : "not available";
  const shots =
    e.access_status === "captured"
      ? `<div class="shots">${shot(image(e, "initial"), "Initial (first visit)", "not available")}${shot(image(e, "after-dismissal"), "After dismissal", afterMissing)}</div>`
      : "";
  const full = image(e, "full-page");
  return `<div class="vp">
<h4>${esc(e.viewport_name)} <span class="sub">${esc(`${e.viewport_width}×${e.viewport_height}`)}</span> ${badge(ACCESS_TONE[e.access_status], e.access_status.replace(/_/g, " "))}
${overlay ? badge(OVERLAY_TONE[overlay], OVERLAY_TEXT[overlay] ?? overlay) : ""} ${e.http_status ? `<span class="sub">HTTP ${esc(e.http_status)}</span>` : ""}</h4>
${shots}
${full ? `<p class="sub"><a href="${esc(full)}" target="_blank" rel="noopener">Full page (after dismissal attempt)</a></p>` : ""}
${notes ? `<p class="note">${esc(notes)}</p>` : ""}
${overlayDetails(e)}
</div>`;
}

function pageCards(rows: StoredEvidence[], image: LocalImage): string {
  const bySlot = new Map<string, StoredEvidence[]>();
  for (const e of orderEvidence(rows)) bySlot.set(e.page_slot, [...(bySlot.get(e.page_slot) ?? []), e]);
  return [...bySlot.entries()]
    .map(([slot, group]) => {
      const first = group.find((g) => g.final_url) ?? group[0];
      const url = first.final_url ?? first.requested_url;
      const href = safeHref(url);
      return `<article class="page">
<div class="page-head"><h3>${esc(slot.replace(/_/g, " "))} <span class="sub">${esc(first.page_type)}</span></h3>
<span class="sub">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(url ?? "no URL")}${first.page_title ? ` · ${esc(first.page_title)}` : ""}</span></div>
<div class="vps">${group.map((e) => viewportBlock(e, image)).join("")}</div>
</article>`;
    })
    .join("\n");
}

export function renderHtmlReport(input: RunReportInput, cost: CostSummary, image: LocalImage): string {
  const v = input.verification;
  const captured = v.coverage.reduce((n, c) => n + c.captured, 0);
  const required = v.coverage.reduce((n, c) => n + c.required, 0);
  const overlayCounts = new Map<string, number>();
  for (const e of input.evidence) if (e.overlay_dismissal_status) overlayCounts.set(e.overlay_dismissal_status, (overlayCounts.get(e.overlay_dismissal_status) ?? 0) + 1);
  const statusTone = input.status === "completed" ? "ok" : input.status === "failed" ? "bad" : "warn";

  const sites = input.sites
    .map((s) => {
      const cov = v.coverage.find((c) => c.domain === s.domain);
      return `<section id="${esc(s.domain)}"><h2>${esc(s.name)} <span class="sub">${esc(s.domain)} · ${esc(s.category)}</span></h2>
<p class="sub">Captured ${cov ? `${cov.captured} / ${cov.required}` : "-"} · robots.txt: ${esc(s.robots)}</p>
${pageCards(input.evidence.filter((e) => e.company_id === s.companyId), image)}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence capture · ${esc(input.startedAt.slice(0, 16).replace("T", " "))}</title><style>${HTML_STYLE}</style></head>
<body><main>
<header class="hero"><p class="eyebrow">Strategy &amp; Design Co. · Evidence capture report</p>
<h1>${esc(input.sites.map((s) => s.name).join(", ") || "Research run")}</h1>
<p class="sub">${badge(statusTone, input.status)} Started ${esc(input.startedAt)} · ended ${esc(input.endedAt)} · run <span class="mono">${esc(input.runId)}</span> · ${esc(input.workerVersion)} via ${esc(input.provider)}</p>
<p class="note">Captures only: no analysis, findings, scores or contacts. “Not observed” means the worker could not find or reach a page, not that it does not exist. The initial screenshot is the untouched first visit; the after-dismissal screenshot was taken only after pressing overlays' own visible controls. <a href="../index.html">All runs</a></p></header>

<div class="grid">
<div class="stat"><span class="sub">Pages captured</span><b>${captured} / ${required}</b></div>
<div class="stat"><span class="sub">Estimated cost</span><b>$${esc(cost.estimatedCostUsd)}</b><span class="sub">${esc(cost.estimatedUnits)} units · ceiling $${esc(cost.ceilings.maxRunCostUsd)}${cost.ceilings.hit ? " · reached" : ""}</span></div>
<div class="stat"><span class="sub">Checks</span><b>${v.checks.filter((c) => c.passed).length} / ${v.checks.length} passed</b><span class="sub">${v.warnings.length} warning(s) to review</span></div>
<div class="stat"><span class="sub">Overlays</span><b>${esc(overlayCounts.get("all_dismissed") ?? 0)} dismissed</b><span class="sub">${[...overlayCounts].filter(([k]) => k !== "all_dismissed").map(([k, n]) => `${n} ${OVERLAY_TEXT[k] ?? k}`).map(esc).join(" · ") || "no other outcomes"}</span></div>
</div>

<h2>Coverage</h2><div class="card"><table><thead><tr><th>Site</th><th class="num">Captured</th><th class="num">Required</th><th>Complete</th></tr></thead><tbody>
${v.coverage.map((c) => `<tr><td><a href="#${esc(c.domain)}">${esc(c.domain)}</a></td><td class="num">${c.captured}</td><td class="num">${c.required}</td><td>${badge(c.complete ? "ok" : "warn", c.complete ? "yes" : "no")}</td></tr>`).join("")}
</tbody></table></div>

<h2>Verification</h2><div class="card">
${v.checks.map((c) => `<div class="check">${badge(c.passed ? "ok" : "bad", c.passed ? "pass" : "fail")} <span>${esc(c.name)}</span></div>${c.problems.length ? `<ul class="actions">${c.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}`).join("")}
${v.warnings.length ? `<h3 style="margin-top:16px">Warnings (need human review)</h3><ul class="actions">${v.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
${input.errors.length ? `<h3 style="margin-top:16px">Run errors</h3><ul class="actions">${input.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
</div>

<h2>Cost (estimate)</h2><div class="card"><p class="sub">${esc(cost.basis)}</p>
<p>${esc(cost.browserSessions)} browser session(s) · ${esc(cost.measuredSessionSeconds)} s measured · ${esc(cost.estimatedUnits)} estimated units at $${esc(cost.unitPriceUsd)}/unit · AI model cost $0</p>
<table><thead><tr><th>Site</th><th class="num">Sessions</th><th class="num">Seconds</th><th class="num">Est. units</th><th class="num">Est. cost</th></tr></thead><tbody>
${cost.perSite.map((s) => `<tr><td>${esc(s.domain)}</td><td class="num">${s.sessions}</td><td class="num">${s.sessionSeconds}</td><td class="num">${s.estimatedUnits}</td><td class="num">$${s.estimatedCostUsd}</td></tr>`).join("")}
</tbody></table></div>

${sites}
<p class="sub">Screenshots open from the local <span class="mono">screenshots/</span> folder next to this report, so they work offline and do not expire.</p>
</main></body></html>
`;
}
