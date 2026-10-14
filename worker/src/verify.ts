import type { StoredEvidence } from "./store.ts";
import { isSameSite } from "./url.ts";

export const REQUIRED_SLOTS = ["homepage", "plp", "pdp_1", "pdp_2"] as const;
export const REQUIRED_VIEWPORTS = ["desktop", "mobile"] as const;

export interface CheckResult {
  name: string;
  passed: boolean;
  problems: string[];
}

export interface SiteCoverage {
  domain: string;
  captured: number;
  required: number;
  complete: boolean;
}

export interface VerificationReport {
  checks: CheckResult[];
  warnings: string[];
  coverage: SiteCoverage[];
  allChecksPassed: boolean;
}

function label(r: StoredEvidence): string {
  return `${r.page_slot}/${r.viewport_name} (${r.id.slice(0, 8)})`;
}

/**
 * Checks that the stored evidence is internally consistent and complete. It verifies that
 * records and files exist and are well-formed; it does not judge what the pages show.
 */
export async function verifyEvidence(
  rows: StoredEvidence[],
  domainByCompany: Map<string, string>,
  screenshotExists: (path: string) => Promise<boolean>,
): Promise<VerificationReport> {
  const completeness: string[] = [];
  const files: string[] = [];
  const explained: string[] = [];
  const matrix: string[] = [];
  const warnings: string[] = [];
  const coverage: SiteCoverage[] = [];

  for (const r of rows) {
    if (r.access_status === "captured") {
      const missing: string[] = (["final_url", "captured_at", "screenshot_path", "content_hash", "user_agent"] as const).filter((k) => !r[k]);
      if (!r.viewport_width || !r.viewport_height) missing.push("viewport");
      if (missing.length) completeness.push(`${label(r)} missing ${missing.join(", ")}`);
      const domain = domainByCompany.get(r.company_id);
      if (r.final_url && domain && !isSameSite(r.final_url, domain)) warnings.push(`${label(r)} redirected off-site to ${r.final_url}`);
      if (r.page_type === "pdp") {
        const s = r.page_type_signals as { jsonLdTypes?: string[]; ogType?: string | null; addToCartControlVisible?: boolean };
        const productSignal = s.jsonLdTypes?.some((t) => /product/i.test(t)) || /product/i.test(s.ogType ?? "") || s.addToCartControlVisible;
        if (!productSignal) warnings.push(`${domain} ${label(r)} classified as product page by URL only; no product markup or add-to-cart control detected`);
      }
    } else {
      if (!r.navigation_notes && !r.error_message && r.access_status !== "blocked") {
        explained.push(`${label(r)} has status ${r.access_status} with no explanation`);
      }
      if (r.access_status === "blocked" && !(r.page_type_signals as { blockReason?: string }).blockReason) {
        explained.push(`${label(r)} marked blocked without a recorded reason`);
      }
    }
    for (const path of [r.screenshot_path, r.full_page_screenshot_path]) {
      if (path && !(await screenshotExists(path))) files.push(`${label(r)} screenshot not found in storage: ${path}`);
    }
  }

  for (const [companyId, domain] of domainByCompany) {
    const siteRows = rows.filter((r) => r.company_id === companyId);
    let captured = 0;
    for (const slot of REQUIRED_SLOTS) {
      for (const vp of REQUIRED_VIEWPORTS) {
        const matches = siteRows.filter((r) => r.page_slot === slot && r.viewport_name === vp);
        if (matches.length !== 1) matrix.push(`${domain} ${slot}/${vp}: expected 1 record, found ${matches.length}`);
        if (matches.some((m) => m.access_status === "captured")) captured++;
      }
    }
    const required = REQUIRED_SLOTS.length * REQUIRED_VIEWPORTS.length;
    coverage.push({ domain, captured, required, complete: captured === required });
  }

  const checks: CheckResult[] = [
    { name: "Every captured page has URL, timestamp, viewport, screenshot, text hash and user agent", passed: !completeness.length, problems: completeness },
    { name: "Every referenced screenshot file exists in storage", passed: !files.length, problems: files },
    { name: "Every non-captured page records why", passed: !explained.length, problems: explained },
    { name: "Each site has exactly one record per required page and viewport", passed: !matrix.length, problems: matrix },
  ];
  return { checks, warnings, coverage, allChecksPassed: checks.every((c) => c.passed) };
}
