import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { escapeHtml as esc, HTML_STYLE } from "./reportHtml.ts";

export const LATEST_LINK = "latest";
const RUN_DIR = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z_[0-9a-f]{8}$/i;
const LEGACY_RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** e.g. 2026-10-15_14-03-22Z_ab12cd34 (UTC, sorts chronologically; the suffix prevents collisions). */
export function runFolderName(startedAt: Date, runId: string): string {
  const iso = startedAt.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, "-")}Z_${runId.slice(0, 8)}`;
}

export type ScreenshotKind = "initial" | "after-dismissal" | "full-page";

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "unknown";

/** Local copy location relative to the run folder: screenshots/<company>/<page>/<viewport>-<state>.<ext>. */
export function localScreenshotPath(domain: string, slot: string, viewport: string, kind: ScreenshotKind): string {
  const ext = kind === "full-page" ? "jpg" : "png";
  return ["screenshots", safe(domain), safe(slot.replace(/_/g, "-")), `${safe(viewport)}-${kind}.${ext}`].join("/");
}

/**
 * Points output/latest at runDir without copying files. Swaps a temporary link into place so a reader
 * never sees it missing. A real folder named "latest" is never touched.
 */
export function updateLatestLink(outputRoot: string, runDir: string): { ok: boolean; detail: string } {
  const link = join(outputRoot, LATEST_LINK);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) return { ok: false, detail: `${link} exists and is not a shortcut, so it was left unchanged` };
  const target = process.platform === "win32" ? resolve(runDir) : relative(outputRoot, runDir);
  const tmp = join(outputRoot, `.latest-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(target, tmp, "junction");
    try {
      renameSync(tmp, link);
    } catch {
      if (existing) unlinkSync(link);
      renameSync(tmp, link);
    }
    return { ok: true, detail: `${link} -> ${target}` };
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, detail: `Could not create the latest shortcut: ${(err as Error).message}` };
  }
}

export function latestTarget(outputRoot: string): string | null {
  const link = join(outputRoot, LATEST_LINK);
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  return resolve(outputRoot, readlinkSync(link));
}

export interface RunListing {
  dir: string;
  folder: string;
  legacy: boolean;
  runId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  sites: string[];
  captured: number | null;
  required: number | null;
  estimatedCostUsd: number | null;
  reportFile: string | null;
}

interface ReportJson {
  runId?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: { estimatedCostUsd?: number };
  verification?: { coverage?: Array<{ domain: string; captured: number; required: number }> };
}

function startedFromName(folder: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})Z_/.exec(folder);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : null;
}

function readListing(dir: string, folder: string, legacy: boolean): RunListing {
  const listing: RunListing = {
    dir,
    folder,
    legacy,
    runId: null,
    status: "no report (run aborted or still running)",
    startedAt: null,
    endedAt: null,
    sites: [],
    captured: null,
    required: null,
    estimatedCostUsd: null,
    reportFile: ["report.html", "report.md"].find((f) => existsSync(join(dir, f))) ?? null,
  };
  const jsonPath = join(dir, "report.json");
  if (!existsSync(jsonPath)) return { ...listing, startedAt: startedFromName(folder) ?? statSync(dir).mtime.toISOString() };
  try {
    const r = JSON.parse(readFileSync(jsonPath, "utf8")) as ReportJson;
    const coverage = r.verification?.coverage ?? [];
    return {
      ...listing,
      runId: r.runId ?? null,
      status: r.status ?? "unknown",
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      sites: coverage.map((c) => c.domain),
      captured: coverage.reduce((n, c) => n + c.captured, 0),
      required: coverage.reduce((n, c) => n + c.required, 0),
      estimatedCostUsd: r.cost?.estimatedCostUsd ?? null,
    };
  } catch {
    return { ...listing, status: "unreadable report.json" };
  }
}

/** Every run folder, newest first: dated folders plus older UUID-named folders (read, never modified). */
export function listRuns(outputRoot: string): RunListing[] {
  if (!existsSync(outputRoot)) return [];
  const runs = readdirSync(outputRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (RUN_DIR.test(d.name) || LEGACY_RUN_DIR.test(d.name)))
    .map((d) => readListing(join(outputRoot, d.name), d.name, LEGACY_RUN_DIR.test(d.name)));
  return runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.folder.localeCompare(a.folder));
}

function statusTone(status: string): string {
  if (status === "completed") return "ok";
  if (status === "completed_with_failures" || status === "stopped_cost_ceiling") return "warn";
  if (status === "failed") return "bad";
  return "muted";
}

export function renderRunIndex(runs: RunListing[], latestDir: string | null, generatedAt: string): string {
  const latest = latestDir ? runs.find((r) => resolve(r.dir) === resolve(latestDir)) : undefined;
  const rows = runs
    .map((r) => {
      const href = r.reportFile ? `${r.folder}/${r.reportFile}` : `${r.folder}/`;
      const when = r.startedAt ? r.startedAt.replace("T", " ").slice(0, 19) + " UTC" : "-";
      const tags = [r === latest ? `<span class="badge ok">latest</span>` : "", r.legacy ? `<span class="badge muted">older format</span>` : ""].join(" ");
      return `<tr>
  <td><a href="${esc(href)}">${esc(when)}</a> ${tags}<div class="sub mono">${esc(r.folder)}</div></td>
  <td><span class="badge ${statusTone(r.status)}">${esc(r.status)}</span></td>
  <td>${esc(r.sites.join(", ") || "-")}</td>
  <td class="num">${r.captured === null ? "-" : `${r.captured} / ${r.required}`}</td>
  <td class="num">${r.estimatedCostUsd === null ? "-" : `$${r.estimatedCostUsd}`}</td>
  <td>${r.reportFile ? `<a href="${esc(href)}">${r.reportFile === "report.html" ? "Open report" : "Markdown report"}</a>` : `<a href="${esc(href)}">Folder</a>`}</td>
</tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research runs</title><style>${HTML_STYLE}</style></head>
<body><main>
<header class="hero"><p class="eyebrow">Strategy &amp; Design Co. · Evidence capture</p><h1>Research runs</h1>
<p class="sub">${runs.length} run(s), newest first. ${latest ? `Latest: <a href="${LATEST_LINK}/${esc(latest.reportFile ?? "")}">${esc(latest.folder)}</a>.` : ""} Generated ${esc(generatedAt)}. Costs are estimates.</p></header>
<section class="card"><table>
<thead><tr><th>Started</th><th>Status</th><th>Sites</th><th class="num">Captured</th><th class="num">Est. cost</th><th>Report</th></tr></thead>
<tbody>
${rows || `<tr><td colspan="6" class="sub">No runs yet.</td></tr>`}
</tbody></table></section>
</main></body></html>
`;
}

export function writeRunIndex(outputRoot: string): string {
  const path = join(outputRoot, "index.html");
  writeFileSync(path, renderRunIndex(listRuns(outputRoot), latestTarget(outputRoot), new Date().toISOString()));
  return path;
}
