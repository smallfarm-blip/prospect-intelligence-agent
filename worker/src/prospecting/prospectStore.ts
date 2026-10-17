import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ProspectScore } from "./scoring.ts";
import type { ProviderCallRecord } from "./spend.ts";
import type { DecisionMaker, Fact, Signal } from "./types.ts";
import type {
  CompanyRow,
  NewDecisionMaker,
  NewFact,
  NewProspect,
  NewSignal,
  NewSource,
  PilotData,
  ProspectStore,
  RunFinish,
  RunStart,
  ScoringSubject,
  ScreeningTarget,
} from "./ports.ts";

function check<T>(result: { data: T; error: { message: string } | null }, action: string): T {
  if (result.error) throw new Error(`${action} failed: ${result.error.message}`);
  return result.data;
}

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
const INDEPENDENT_TRAITS = new Set(["category", "sells_dtc", "business_model", "hq_country", "revenue_annual_usd", "employee_count"]);
const chunk = <T>(items: T[], size = 200): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

type FactRow = { company_id: string; attribute: string; value_text: string; value_number: number | null; status: string; source_type: string; source_url: string | null; provider: string | null; excerpt: string | null; notes: string | null; checked_at: string };

/** Writes Phase 2A prospecting records with the server-side secret key. */
export class SupabaseProspectStore implements ProspectStore {
  private readonly db: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async preflight(): Promise<void> {
    check(await this.db.from("discovery_runs").select("id").limit(1), "Prospecting schema check (is the Phase 2A migration applied and the secret key correct?)");
  }

  async pilotSpendUsd(pilot: string): Promise<number> {
    // Summed from the call log so a run that crashed before finishing still counts.
    const calls = check(
      await this.db.from("provider_calls").select("actual_cost_usd, discovery_runs!inner(pilot)").eq("discovery_runs.pilot", pilot),
      "Read pilot spend",
    ) as unknown as Array<{ actual_cost_usd: number | string }>;
    return calls.reduce((s, c) => s + Number(c.actual_cost_usd ?? 0), 0);
  }

  async startRun(run: RunStart): Promise<string> {
    const row = check(
      await this.db
        .from("discovery_runs")
        .insert({ pilot: run.pilot, mode: run.mode, provider: run.provider, status: "running", budget_usd: run.budgetUsd, config: run.config, worker_version: run.workerVersion })
        .select("id")
        .single(),
      "Start discovery run",
    ) as { id: string };
    return row.id;
  }

  async finishRun(runId: string, finish: RunFinish): Promise<void> {
    check(
      await this.db
        .from("discovery_runs")
        .update({ status: finish.status, spent_usd: Math.round(finish.spentUsd * 1e6) / 1e6, summary: finish.summary, ended_at: new Date().toISOString() })
        .eq("id", runId),
      "Finish discovery run",
    );
  }

  async recordCall(runId: string, r: ProviderCallRecord): Promise<string> {
    const row = check(
      await this.db
        .from("provider_calls")
        .insert({
          discovery_run_id: runId,
          company_id: r.companyId,
          provider: r.provider,
          operation: r.operation,
          method: r.method,
          query: clip(r.query, 2000),
          params: r.params,
          status: r.status,
          result_count: r.resultCount,
          worst_case_usd: r.worstCaseUsd,
          actual_cost_usd: r.actualCostUsd,
          cost_basis: r.costBasis,
          request_id: r.requestId,
          error: clip(r.error, 500),
        })
        .select("id")
        .single(),
      "Record provider call",
    ) as { id: string };
    return row.id;
  }

  async findCompanies(domains: string[]): Promise<Map<string, CompanyRow>> {
    const found = new Map<string, CompanyRow>();
    for (const part of chunk([...new Set(domains)])) {
      if (!part.length) continue;
      const rows = check(await this.db.from("companies").select("id, name, canonical_domain").in("canonical_domain", part), "Find companies") as Array<{ id: string; name: string; canonical_domain: string }>;
      for (const r of rows) found.set(r.canonical_domain, { id: r.id, name: r.name, domain: r.canonical_domain });
    }
    return found;
  }

  async createProspect(p: NewProspect): Promise<CompanyRow> {
    const company = check(
      await this.db
        .from("companies")
        .insert({ name: p.name.slice(0, 200), canonical_domain: p.domain, source: p.origin, geography: p.geography, source_notes: clip(p.description, 1000) })
        .select("id, name, canonical_domain")
        .single(),
      "Create company",
    ) as { id: string; name: string; canonical_domain: string };
    check(
      await this.db.from("prospects").insert({
        company_id: company.id,
        origin: p.origin,
        pilot: p.pilot,
        description: clip(p.description, 1000),
        excluded_reason: p.excludedReason,
        excluded_rule: p.excludedRule,
        first_discovery_run_id: p.runId,
      }),
      "Create prospect",
    );
    return { id: company.id, name: company.name, domain: company.canonical_domain };
  }

  async addSources(rows: NewSource[]): Promise<void> {
    if (!rows.length) return;
    check(
      await this.db.from("prospect_sources").insert(
        rows.map((s) => ({
          company_id: s.companyId,
          provider_call_id: s.providerCallId,
          kind: s.kind,
          url: s.url,
          title: clip(s.title, 300),
          published_at: s.publishedAt,
          excerpt: clip(s.excerpt, 600),
          rank: s.rank,
          outcome: s.outcome,
          provider_record: s.providerRecord,
        })),
      ),
      "Add prospect sources",
    );
  }

  async addFacts(companyId: string, facts: NewFact[]): Promise<void> {
    if (!facts.length) return;
    check(
      await this.db.from("prospect_facts").insert(
        facts.map((f) => ({
          company_id: companyId,
          attribute: f.attribute,
          value_text: f.valueText.slice(0, 300),
          value_number: f.valueNumber,
          status: f.status,
          source_type: f.sourceType,
          source_url: f.sourceUrl,
          provider: f.provider,
          excerpt: clip(f.excerpt, 600),
          notes: clip(f.notes ?? null, 1000),
          provider_call_id: f.providerCallId,
          checked_at: f.checkedAt,
        })),
      ),
      "Add prospect facts",
    );
  }

  async screeningTargets(pilot: string, limit: number): Promise<ScreeningTarget[]> {
    const rows = check(
      await this.db
        .from("prospects")
        .select("description, companies!inner(id, name, canonical_domain)")
        .eq("pilot", pilot)
        .is("excluded_reason", null)
        .is("screened_at", null)
        .order("created_at")
        .limit(limit),
      "List screening targets",
    ) as unknown as Array<{ description: string | null; companies: { id: string; name: string; canonical_domain: string } }>;
    return rows.map((r) => ({ id: r.companies.id, name: r.companies.name, domain: r.companies.canonical_domain, description: r.description }));
  }

  async addDecisionMakers(companyId: string, rows: NewDecisionMaker[]): Promise<void> {
    if (!rows.length) return;
    check(
      await this.db.from("decision_makers").upsert(
        rows.map((d) => ({
          company_id: companyId,
          name: d.name.slice(0, 120),
          title: clip(d.title, 200),
          role_category: d.roleCategory,
          profile_url: d.profileUrl,
          source_url: d.sourceUrl,
          provider: d.provider,
          source_published_at: d.sourcePublishedAt,
          provider_call_id: d.providerCallId,
        })),
        { onConflict: "company_id,profile_url", ignoreDuplicates: true },
      ),
      "Add decision-makers",
    );
  }

  async addSignals(companyId: string, runId: string, rows: NewSignal[]): Promise<void> {
    if (!rows.length) return;
    check(
      await this.db.from("screening_signals").insert(
        rows.map((s) => ({
          company_id: companyId,
          discovery_run_id: runId,
          provider_call_id: s.providerCallId,
          signal_type: s.signalType,
          title: s.title,
          observed_evidence: s.observedEvidence,
          interpretation: s.interpretation,
          business_relevance: s.businessRelevance,
          critical_unknowns: s.criticalUnknowns,
          next_validation: s.nextValidation,
          source_urls: s.sourceUrls,
          confidence: s.confidence,
          model: s.model,
          prompt_version: s.promptVersion,
        })),
      ),
      "Add screening signals",
    );
  }

  async markScreened(companyId: string, summary: string | null): Promise<void> {
    check(
      await this.db.from("prospects").update({ screened_at: new Date().toISOString(), screening_summary: clip(summary, 1500) }).eq("company_id", companyId),
      "Mark screened",
    );
  }

  async scoringSubjects(companyIds: string[] | null): Promise<ScoringSubject[]> {
    let q = this.db.from("prospects").select("company_id, excluded_reason, screened_at, companies!inner(name, canonical_domain)");
    if (companyIds) q = q.in("company_id", companyIds);
    const prospects = check(await q, "List prospects to score") as unknown as Array<{
      company_id: string;
      excluded_reason: string | null;
      screened_at: string | null;
      companies: { name: string; canonical_domain: string };
    }>;
    if (!prospects.length) return [];
    const ids = prospects.map((p) => p.company_id);
    const facts = await this.factsFor(ids);
    const signals = await this.signalsFor(ids);
    const people = await this.decisionMakersFor(ids);
    return prospects.map((p) => ({
      id: p.company_id,
      name: p.companies.name,
      domain: p.companies.canonical_domain,
      input: {
        facts: facts.get(p.company_id) ?? [],
        signals: signals.get(p.company_id) ?? [],
        decisionMakers: people.get(p.company_id) ?? [],
        screened: p.screened_at !== null,
        excludedReason: p.excluded_reason,
      },
    }));
  }

  async saveScore(companyId: string, runId: string | null, s: ProspectScore): Promise<void> {
    check(
      await this.db.from("prospect_scores").insert({
        company_id: companyId,
        discovery_run_id: runId,
        scoring_version: s.scoringVersion,
        evidence_score: s.evidenceScore,
        potential_min: s.potentialMin,
        potential_max: s.potentialMax,
        confidence: s.confidence,
        coverage: s.coverage,
        fit_status: s.fitStatus,
        components: s.components,
        unresolved: s.unresolved,
        reasons_to_investigate: s.reasonsToInvestigate,
        commercial_relevance: s.commercialRelevance,
        organizational_fit: s.organizationalFit,
        recommended_action: s.recommendedAction,
      }),
      "Save prospect score",
    );
  }

  async reportData(pilot: string): Promise<PilotData> {
    const prospects = check(
      await this.db.from("prospects").select("company_id, origin, excluded_reason, companies!inner(name, canonical_domain)").eq("pilot", pilot),
      "Load pilot prospects",
    ) as unknown as Array<{ company_id: string; origin: string; excluded_reason: string | null; companies: { name: string; canonical_domain: string } }>;
    const runs = check(await this.db.from("discovery_runs").select("id").eq("pilot", pilot), "Load pilot runs") as Array<{ id: string }>;
    const runIds = runs.map((r) => r.id);
    const ids = prospects.map((p) => p.company_id);

    const calls = runIds.length
      ? (check(
          await this.db.from("provider_calls").select("id, operation, method, query, status, result_count, actual_cost_usd, cost_basis").in("discovery_run_id", runIds).order("executed_at"),
          "Load provider calls",
        ) as Array<{ id: string; operation: string; method: string; query: string | null; status: string; result_count: number | null; actual_cost_usd: number | string; cost_basis: string }>)
      : [];
    const callIds = calls.map((c) => c.id);
    const outcomes: PilotData["sourceOutcomes"] = [];
    for (const part of chunk(callIds)) {
      const rows = check(
        await this.db.from("prospect_sources").select("provider_call_id, company_id, outcome").in("provider_call_id", part).not("outcome", "is", null),
        "Load source outcomes",
      ) as Array<{ provider_call_id: string; company_id: string; outcome: string }>;
      outcomes.push(...rows.map((r) => ({ providerCallId: r.provider_call_id, companyId: r.company_id, outcome: r.outcome })));
    }

    const latestScore = await this.latestBy<{ company_id: string; evidence_score: number; potential_max: number; fit_status: string; confidence: string; coverage: number | string; unresolved: string[]; reasons_to_investigate: string[]; recommended_action: string }>(
      "prospect_scores",
      "company_id, evidence_score, potential_max, fit_status, confidence, coverage, unresolved, reasons_to_investigate, recommended_action, computed_at",
      "computed_at",
      ids,
    );
    const overrides = await this.rowsFor<{ company_id: string; field: string; new_value: string; created_at: string }>("prospect_overrides", "company_id, field, new_value, created_at", "created_at", ids);
    const decisions = await this.rowsFor<{ company_id: string; decision: string; review_seconds: number | null; created_at: string }>("prospect_decisions", "company_id, decision, review_seconds, created_at", "created_at", ids);
    const people = await this.decisionMakersFor(ids);
    const facts = await this.factsFor(ids);

    return {
      pilot,
      calls: calls.map((c) => ({ id: c.id, operation: c.operation, method: c.method, query: c.query, status: c.status, resultCount: c.result_count, actualCostUsd: Number(c.actual_cost_usd), costBasis: c.cost_basis })),
      sourceOutcomes: outcomes,
      companies: prospects.map((p) => {
        const s = latestScore.get(p.company_id);
        const own = overrides.filter((o) => o.company_id === p.company_id);
        const lastOf = (field: string) => own.filter((o) => o.field === field).at(-1)?.new_value ?? null;
        const scoreOverride = lastOf("score");
        const ds = decisions.filter((d) => d.company_id === p.company_id);
        const dm = people.get(p.company_id) ?? [];
        const verifiedTraits = new Set((facts.get(p.company_id) ?? []).filter((f) => f.status === "verified" && f.sourceType !== "provider" && INDEPENDENT_TRAITS.has(f.attribute)).map((f) => f.attribute));
        return {
          id: p.company_id,
          name: p.companies.name,
          domain: p.companies.canonical_domain,
          origin: p.origin,
          excludedReason: p.excluded_reason,
          score: s
            ? {
                evidenceScore: s.evidence_score,
                potentialMax: s.potential_max,
                fitStatus: s.fit_status as ProspectScore["fitStatus"],
                confidence: s.confidence as ProspectScore["confidence"],
                coverage: Number(s.coverage),
                unresolved: s.unresolved ?? [],
                reasonsToInvestigate: s.reasons_to_investigate ?? [],
                recommendedAction: s.recommended_action,
              }
            : null,
          scoreOverride: scoreOverride === null ? null : Number(scoreOverride),
          fitOverride: lastOf("fit_status"),
          latestDecision: ds.at(-1)?.decision ?? null,
          reviewSeconds: ds.map((d) => d.review_seconds).filter((n): n is number => typeof n === "number" && n > 0),
          decisionMakers: { possible: dm.filter((d) => d.review !== "rejected").length, confirmed: dm.filter((d) => d.review === "confirmed").length },
          verifiedIndependentTraits: verifiedTraits.size,
          discoveredByCallIds: outcomes.filter((o) => o.companyId === p.company_id).map((o) => o.providerCallId),
        };
      }),
    };
  }

  private async rowsFor<T>(table: string, columns: string, orderBy: string, ids: string[]): Promise<T[]> {
    const out: T[] = [];
    for (const part of chunk(ids)) {
      if (!part.length) continue;
      out.push(...(check(await this.db.from(table).select(columns).in("company_id", part).order(orderBy), `Load ${table}`) as unknown as T[]));
    }
    return out;
  }

  private async latestBy<T extends { company_id: string }>(table: string, columns: string, orderBy: string, ids: string[]): Promise<Map<string, T>> {
    const latest = new Map<string, T>();
    for (const row of await this.rowsFor<T>(table, columns, orderBy, ids)) latest.set(row.company_id, row);
    return latest;
  }

  private async factsFor(ids: string[]): Promise<Map<string, Fact[]>> {
    const rows = await this.rowsFor<FactRow>("prospect_facts", "company_id, attribute, value_text, value_number, status, source_type, source_url, provider, excerpt, notes, checked_at", "checked_at", ids);
    const map = new Map<string, Fact[]>();
    for (const r of rows) {
      const list = map.get(r.company_id) ?? [];
      list.push({
        attribute: r.attribute as Fact["attribute"],
        valueText: r.value_text,
        valueNumber: r.value_number === null ? null : Number(r.value_number),
        status: r.status as Fact["status"],
        sourceType: r.source_type as Fact["sourceType"],
        sourceUrl: r.source_url,
        provider: r.provider,
        excerpt: r.excerpt,
        notes: r.notes,
        checkedAt: r.checked_at,
      });
      map.set(r.company_id, list);
    }
    return map;
  }

  private async signalsFor(ids: string[]): Promise<Map<string, Signal[]>> {
    const rows = await this.rowsFor<{
      company_id: string;
      signal_type: Signal["signalType"];
      title: string;
      observed_evidence: string;
      interpretation: string;
      business_relevance: string;
      critical_unknowns: string[];
      next_validation: string;
      source_urls: string[];
      confidence: Signal["confidence"];
    }>("screening_signals", "company_id, signal_type, title, observed_evidence, interpretation, business_relevance, critical_unknowns, next_validation, source_urls, confidence, created_at", "created_at", ids);
    const map = new Map<string, Signal[]>();
    for (const r of rows) {
      const list = map.get(r.company_id) ?? [];
      list.push({
        signalType: r.signal_type,
        title: r.title,
        observedEvidence: r.observed_evidence,
        interpretation: r.interpretation,
        businessRelevance: r.business_relevance,
        criticalUnknowns: r.critical_unknowns ?? [],
        nextValidation: r.next_validation,
        sourceUrls: r.source_urls ?? [],
        confidence: r.confidence,
      });
      map.set(r.company_id, list);
    }
    return map;
  }

  private async decisionMakersFor(ids: string[]): Promise<Map<string, DecisionMaker[]>> {
    const rows = await this.rowsFor<{ id: string; company_id: string; name: string; title: string | null; role_category: DecisionMaker["roleCategory"]; profile_url: string | null; source_url: string | null; source_published_at: string | null }>(
      "decision_makers",
      "id, company_id, name, title, role_category, profile_url, source_url, source_published_at, discovered_at",
      "discovered_at",
      ids,
    );
    const reviews = new Map<string, "confirmed" | "rejected">();
    for (const part of chunk(rows.map((r) => r.id))) {
      if (!part.length) continue;
      const rs = check(await this.db.from("decision_maker_reviews").select("decision_maker_id, decision, created_at").in("decision_maker_id", part).order("created_at"), "Load decision-maker reviews") as Array<{
        decision_maker_id: string;
        decision: "confirmed" | "rejected";
      }>;
      for (const r of rs) reviews.set(r.decision_maker_id, r.decision);
    }
    const map = new Map<string, DecisionMaker[]>();
    for (const r of rows) {
      const list = map.get(r.company_id) ?? [];
      list.push({ name: r.name, title: r.title, roleCategory: r.role_category, profileUrl: r.profile_url, sourceUrl: r.source_url, sourcePublishedAt: r.source_published_at, review: reviews.get(r.id) ?? null });
      map.set(r.company_id, list);
    }
    return map;
  }
}
