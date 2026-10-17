import { costUsd, worstCaseUsd } from "../analysis/budget.ts";
import type { ModelSettings } from "../analysis/config.ts";
import type { ModelClient, ModelRequest } from "../analysis/model.ts";
import { toolSchema } from "../analysis/schemas.ts";
import type { Logger } from "../logger.ts";
import type { NewSource, ProspectStore, ScreeningTarget } from "./ports.ts";
import type { DiscoveryProvider } from "./provider.ts";
import { scoreProspect } from "./scoring.ts";
import { mentionsCompany, parsePeopleHits, SCREENING_PROMPT_VERSION, SCREENING_SYSTEM, ScreeningSchema, screeningContent, validateScreening, type ScreeningSource } from "./screening.ts";
import type { SiteCheck } from "./siteCheck.ts";
import type { SpendGuard } from "./spend.ts";

export interface ScreenDeps {
  provider: DiscoveryProvider;
  model: ModelClient;
  modelSettings: ModelSettings;
  inputCountMargin: number;
  guard: SpendGuard;
  store: ProspectStore;
  logger: Logger;
  runId: string;
  checkSite: (domain: string) => Promise<SiteCheck>;
  now?: () => Date;
}

export interface ScreenOutcome {
  companyId: string;
  domain: string;
  site: SiteCheck["status"];
  decisionMakers: number;
  evidenceSources: number;
  signals: number;
  screened: boolean;
  refused: string[];
  issues: string[];
}

export function screeningRequest(settings: ModelSettings, content: string): ModelRequest {
  return {
    role: "screening",
    settings,
    system: SCREENING_SYSTEM,
    content: [{ type: "text", text: content }],
    tool: { name: "record_screening", description: "Record the screening result for this company", inputSchema: toolSchema(ScreeningSchema) },
  };
}

/** Free site check, then (each refused if the budget cannot cover its worst case) people search, evidence search and AI screening, then scoring. */
export async function screenCompany(deps: ScreenDeps, target: ScreeningTarget, opts: { evidenceMonths: number }): Promise<ScreenOutcome> {
  const company = { name: target.name, domain: target.domain };
  const outcome: ScreenOutcome = { companyId: target.id, domain: target.domain, site: "unreachable", decisionMakers: 0, evidenceSources: 0, signals: 0, screened: false, refused: [], issues: [] };
  const sources: NewSource[] = [];
  const screeningSources: ScreeningSource[] = [];

  const site = await deps.checkSite(target.domain);
  outcome.site = site.status;
  outcome.issues.push(...site.notes);
  if (site.facts.length) await deps.store.addFacts(target.id, site.facts);
  if (site.status === "checked") {
    sources.push({ companyId: target.id, providerCallId: null, kind: "company_site", url: site.url, title: site.title?.slice(0, 300) ?? null, publishedAt: null, excerpt: site.description?.slice(0, 600) ?? null, rank: null, outcome: null, providerRecord: null });
    const detected = site.facts.map((f) => `${f.attribute.replace(/_/g, " ")}: ${f.valueText}`).join("; ");
    screeningSources.push({ ref: "S1", url: site.url, kind: "company homepage", title: site.title, publishedDate: null, text: [site.description ? `Meta description: ${site.description}` : "", `Detected in homepage source: ${detected}`, `Visible text (truncated): ${site.pageText}`].filter(Boolean).join("\n") });
  }

  const people = await deps.guard.search(deps.provider, { operation: "people_search", query: `${target.name} (${target.domain}) founder, CEO, head of ecommerce or director of digital`, numResults: 5 }, target.id);
  if (people.ok) {
    const dms = parsePeopleHits(people.value.hits, company, deps.provider.name, people.callId);
    if (dms.length) await deps.store.addDecisionMakers(target.id, dms);
    outcome.decisionMakers = dms.length;
  } else if (people.refused) outcome.refused.push("people_search");
  else outcome.issues.push(`People search failed: ${people.error}`);

  const since = new Date((deps.now?.() ?? new Date()).getTime() - opts.evidenceMonths * 30.5 * 86_400_000).toISOString().slice(0, 10);
  const evidence = await deps.guard.search(deps.provider, { operation: "evidence_search", query: `${target.name} (${target.domain}) brand news: launch, expansion, funding, new hire, retail partnership or ecommerce`, numResults: 5, startPublishedDate: since }, target.id);
  if (evidence.ok) {
    const relevant = evidence.value.hits.filter((h) => mentionsCompany(h, company));
    for (const [i, h] of relevant.entries()) {
      sources.push({ companyId: target.id, providerCallId: evidence.callId, kind: "news", url: h.url, title: h.title?.slice(0, 300) ?? null, publishedAt: h.publishedDate, excerpt: h.excerpt, rank: i + 1, outcome: null, providerRecord: null });
      screeningSources.push({ ref: `S${screeningSources.length + 1}`, url: h.url, kind: "news or web mention", title: h.title, publishedDate: h.publishedDate, text: h.excerpt ?? "" });
    }
    outcome.evidenceSources = relevant.length;
  } else if (evidence.refused) outcome.refused.push("evidence_search");
  else outcome.issues.push(`Evidence search failed: ${evidence.error}`);
  if (sources.length) await deps.store.addSources(sources);

  let summary: string | null = null;
  if (screeningSources.length) {
    const req = screeningRequest(deps.modelSettings, screeningContent({ ...company, description: target.description }, screeningSources, site.notes));
    const counted = await deps.model.countInputTokens(req);
    const worst = worstCaseUsd(deps.modelSettings.pricing, counted.tokens, deps.inputCountMargin, deps.modelSettings.maxOutputTokens);
    const ai = await deps.guard.run(
      { provider: deps.model.provider, operation: "ai_screening", method: `${deps.model.provider}:${deps.modelSettings.model}:${SCREENING_PROMPT_VERSION}`, query: null, params: { model: deps.modelSettings.model, maxOutputTokens: deps.modelSettings.maxOutputTokens, sources: screeningSources.length }, companyId: target.id, worstCaseUsd: worst },
      async () => {
        const res = await deps.model.complete(req);
        return { value: res, costUsd: costUsd(deps.modelSettings.pricing, res.inputTokens, res.outputTokens), basis: "computed_from_usage" as const, resultCount: null, requestId: null };
      },
    );
    if (ai.ok) {
      const v = validateScreening(ai.value.toolInput, screeningSources, ai.callId);
      if ("error" in v) outcome.issues.push(v.error);
      else {
        if (v.signals.length) await deps.store.addSignals(target.id, deps.runId, v.signals.map((s) => ({ ...s, providerCallId: ai.callId, model: deps.modelSettings.model, promptVersion: SCREENING_PROMPT_VERSION })));
        if (v.facts.length) await deps.store.addFacts(target.id, v.facts);
        outcome.signals = v.signals.length;
        outcome.issues.push(...v.issues);
        outcome.screened = true;
        summary = v.summary;
      }
    } else if (ai.refused) outcome.refused.push("ai_screening");
    else outcome.issues.push(`AI screening failed: ${ai.error}`);
  } else outcome.issues.push("No sources to screen; AI screening skipped");

  if (outcome.screened) await deps.store.markScreened(target.id, summary);
  await rescore(deps.store, [target.id], deps.runId);
  deps.logger.log("info", "company_screened", { ...outcome });
  return outcome;
}

export async function rescore(store: ProspectStore, companyIds: string[] | null, runId: string | null): Promise<number> {
  const subjects = await store.scoringSubjects(companyIds);
  for (const s of subjects) await store.saveScore(s.id, runId, scoreProspect(s.input));
  return subjects.length;
}
