import type {
  DiscoverySegment,
  FitStatus,
  ImportRow,
  NextAction,
  NextActionKey,
  ProspectBoard,
  ProspectDecision,
  ProspectDecisionKind,
  ProspectOverride,
  ProspectRow,
  ProspectScore,
  ResearchRunSummary,
} from './prospectTypes';

export type Queue = 'verified_fit' | 'probable_fit' | 'needs_qualification' | 'not_scored' | 'set_aside';
export const QUEUES: Queue[] = ['verified_fit', 'probable_fit', 'needs_qualification', 'not_scored', 'set_aside'];
export type ReviewState = 'open' | 'shortlisted' | 'on_hold' | 'deferred' | 'research_requested' | 'rejected';

const STATE_OF: Record<ProspectDecisionKind, ReviewState> = {
  shortlist: 'shortlisted',
  hold: 'on_hold',
  defer: 'deferred',
  reject: 'rejected',
  reopen: 'open',
  request_research: 'research_requested',
};

export interface EffectiveNextAction {
  key: NextActionKey;
  /** What the scoring recommended from the evidence; kept even when a reviewer overrides it. */
  system: NextAction | null;
  override: ProspectOverride | null;
  priority: number;
}

export interface ProspectView {
  id: string;
  name: string;
  domain: string;
  prospect: ProspectRow;
  score: ProspectScore | null;
  scoreValue: number | null;
  scoreOverride: ProspectOverride | null;
  fit: FitStatus | null;
  fitOverride: ProspectOverride | null;
  nextAction: EffectiveNextAction | null;
  decision: ProspectDecision | null;
  state: ReviewState;
  reopened: boolean;
  setAside: boolean;
  queue: Queue;
  segments: DiscoverySegment[];
  research: ResearchRunSummary[];
}

const newestFirst = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** A reopen stays in effect until a later reject, matching the database rule for research requests. */
export function isReopened(decisions: ProspectDecision[]): boolean {
  const sorted = [...decisions].sort(newestFirst);
  const lastReopen = sorted.findIndex((d) => d.decision === 'reopen');
  const lastReject = sorted.findIndex((d) => d.decision === 'reject');
  return lastReopen !== -1 && (lastReject === -1 || lastReopen < lastReject);
}

export function buildViews(board: ProspectBoard): ProspectView[] {
  const scores = groupBy(board.scores, (s) => s.company_id);
  const overrides = groupBy(board.overrides, (o) => o.company_id);
  const decisions = groupBy(board.decisions, (d) => d.company_id);
  const segments = groupBy(board.segments, (s) => s.company_id);
  const research = groupBy(board.research, (r) => r.company_id);

  return board.prospects.map((p) => {
    const id = p.company_id;
    const score = [...(scores.get(id) ?? [])].sort((a, b) => b.computed_at.localeCompare(a.computed_at) || b.id.localeCompare(a.id))[0] ?? null;
    const own = [...(overrides.get(id) ?? [])].sort(newestFirst);
    const scoreOverride = own.find((o) => o.field === 'score') ?? null;
    const fitOverride = own.find((o) => o.field === 'fit_status') ?? null;
    const actionOverride = own.find((o) => o.field === 'next_action') ?? null;
    const system = score?.qualification?.nextAction ?? null;
    const actionKey = (actionOverride?.new_value as NextActionKey | undefined) ?? system?.key ?? null;
    const nextAction: EffectiveNextAction | null = actionKey
      ? { key: actionKey, system, override: actionOverride, priority: actionKey === 'defer' ? 0 : system?.priority ?? 0 }
      : null;
    const history = decisions.get(id) ?? [];
    const decision = [...history].sort(newestFirst)[0] ?? null;
    const state = decision ? STATE_OF[decision.decision] : 'open';
    const scoreValue = scoreOverride ? Number(scoreOverride.new_value) : score ? Number(score.evidence_score) : null;
    const fit = (fitOverride?.new_value as FitStatus | undefined) ?? score?.fit_status ?? null;
    const reopened = isReopened(history);
    const setAside = state === 'rejected' || (!reopened && (p.excluded_reason !== null || fit === 'not_fit'));
    const queue: Queue = setAside ? 'set_aside' : fit === null ? 'not_scored' : fit === 'not_fit' ? 'needs_qualification' : fit;
    return {
      id,
      name: p.companies?.name ?? 'Unnamed company',
      domain: p.companies?.canonical_domain ?? '',
      prospect: p,
      score,
      scoreValue,
      scoreOverride,
      fit,
      fitOverride,
      nextAction,
      decision,
      state,
      reopened,
      setAside,
      queue,
      segments: [...new Set((segments.get(id) ?? []).map((s) => s.discovery_segment))],
      research: research.get(id) ?? [],
    };
  });
}

export type StateFilter = 'active' | 'all' | ReviewState;
export type SortKey = 'score' | 'potential' | 'recent' | 'name';

export interface ProspectFilters {
  search: string;
  segment: DiscoverySegment | 'all' | 'none';
  state: StateFilter;
  origin: string;
  sort: SortKey;
}

export const DEFAULT_PROSPECT_FILTERS: ProspectFilters = { search: '', segment: 'all', state: 'active', origin: 'all', sort: 'score' };

const ACTIVE: ReviewState[] = ['open', 'shortlisted', 'research_requested'];

export function matchesFilters(v: ProspectView, f: ProspectFilters): boolean {
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = [v.name, v.domain, v.prospect.companies?.category, v.prospect.companies?.geography, v.prospect.description].filter(Boolean).join(' ').toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  if (f.segment === 'none' ? v.segments.length > 0 : f.segment !== 'all' && !v.segments.includes(f.segment)) return false;
  if (f.state === 'active' ? !ACTIVE.includes(v.state) : f.state !== 'all' && v.state !== f.state) return false;
  if (f.origin !== 'all' && v.prospect.origin !== f.origin) return false;
  return true;
}

const byScore = (a: ProspectView, b: ProspectView) =>
  (b.scoreValue ?? -1) - (a.scoreValue ?? -1) || (b.score?.potential_max ?? -1) - (a.score?.potential_max ?? -1) || a.name.localeCompare(b.name);

const SORTS: Record<SortKey, (a: ProspectView, b: ProspectView) => number> = {
  score: byScore,
  potential: (a, b) => (b.score?.potential_max ?? -1) - (a.score?.potential_max ?? -1) || byScore(a, b),
  recent: (a, b) => b.prospect.created_at.localeCompare(a.prospect.created_at),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function filterViews(views: ProspectView[], f: ProspectFilters): ProspectView[] {
  return views.filter((v) => matchesFilters(v, f)).sort(SORTS[f.sort]);
}

export function queueCounts(views: ProspectView[]): Record<Queue, number> {
  const out = Object.fromEntries(QUEUES.map((q) => [q, 0])) as Record<Queue, number>;
  for (const v of views) out[v.queue] += 1;
  return out;
}

export interface Recommendation {
  view: ProspectView;
  reasons: string[];
}

const RECOMMENDABLE: Queue[] = ['verified_fit', 'probable_fit', 'needs_qualification'];

const byInvestigationValue = (a: ProspectView, b: ProspectView) => (b.nextAction?.priority ?? -1) - (a.nextAction?.priority ?? -1) || byScore(a, b);

/** Companies worth investigating next, ranked by investigation value and realistic consulting potential; not outreach-ready leads. */
export function topRecommendations(views: ProspectView[], limit = 5): Recommendation[] {
  return views
    .filter((v) => v.score && RECOMMENDABLE.includes(v.queue) && (v.state === 'open' || v.state === 'shortlisted') && v.nextAction?.key !== 'defer')
    .sort(byInvestigationValue)
    .slice(0, limit)
    .map((view) => {
      const s = view.score!;
      const evidence = view.nextAction?.system?.evidence ?? [];
      const reasons = (evidence.length ? evidence : [...(s.qualification?.fitBasis?.slice(0, 1) ?? []), ...s.reasons_to_investigate]).slice(0, 2);
      return { view, reasons };
    });
}

/** Mirrors the database rules in check_prospect_decision so unavailable actions are never offered. */
export function availableActions(v: ProspectView): ProspectDecisionKind[] {
  if (v.state === 'rejected') return ['reopen'];
  if (v.setAside) return ['reopen', 'reject'];
  const out: ProspectDecisionKind[] = [];
  if (v.state !== 'shortlisted') out.push('shortlist');
  if (v.fit !== null && v.state !== 'research_requested') out.push('request_research');
  if (v.state !== 'on_hold') out.push('hold');
  if (v.state !== 'deferred') out.push('defer');
  out.push('reject');
  if (v.state === 'on_hold' || v.state === 'deferred') out.push('reopen');
  return out;
}

export const REASON_MIN = 10;
export const REASON_MAX = 2000;

export function reasonProblem(reason: string): string | null {
  const n = reason.trim().length;
  if (n < REASON_MIN) return `Add a reason of at least ${REASON_MIN} characters`;
  if (n > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters`;
  return null;
}

export function scoreOverrideProblem(value: string, current: number | null): string | null {
  if (current === null) return 'This company has not been scored yet';
  if (!/^(100|[1-9]?[0-9])$/.test(value.trim())) return 'Enter a whole number from 0 to 100';
  if (Number(value) === current) return 'That is already the current score';
  return null;
}

export function fitOverrideProblem(value: FitStatus, current: FitStatus | null): string | null {
  if (current === null) return 'This company has not been scored yet';
  if (value === current) return 'That is already the current fit status';
  return null;
}

export function nextActionOverrideProblem(value: NextActionKey, current: NextActionKey | null): string | null {
  if (current === null) return 'This company has no recommended next action yet; rescoring will add one';
  if (value === current) return 'That is already the current next action';
  return null;
}

export interface CostEstimate {
  usd: number;
  samples: number;
  basis: string;
}

export const DEFAULT_RESEARCH_ALLOWANCE_USD = 0.5;

/** Average all-in cost (site capture + analysis) of earlier completed deep-research runs. */
export function estimateResearchCost(runs: ResearchRunSummary[]): CostEstimate {
  const costs = runs
    .filter((r) => r.status === 'completed')
    .map((r) => Number(r.billed_cost_usd ?? r.estimated_cost_usd ?? 0) + Number(r.research_runs?.estimated_cost_usd ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!costs.length) {
    return { usd: DEFAULT_RESEARCH_ALLOWANCE_USD, samples: 0, basis: 'No completed analyses to average yet, so this uses a default allowance' };
  }
  const avg = costs.reduce((s, n) => s + n, 0) / costs.length;
  const usd = Math.min(100, Math.ceil(avg * 100) / 100);
  return { usd, samples: costs.length, basis: `Average of ${costs.length} earlier site capture${costs.length === 1 ? '' : 's'} and analys${costs.length === 1 ? 'is' : 'es'}` };
}

export const MAX_IMPORT = 200;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Same normalisation as public.normalize_prospect_domain. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:[0-9]+$/, '')
    .replace(/^www\./, '');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMNS: Record<keyof ImportRow, string[]> = {
  name: ['name', 'company', 'company name', 'brand'],
  domain: ['domain', 'website', 'url', 'site'],
  category: ['category', 'vertical'],
  country: ['country', 'hq', 'hq country', 'location'],
  notes: ['notes', 'description', 'note'],
};

export interface CsvRows {
  rows: Array<{ line: number; row: ImportRow }>;
  error: string | null;
}

export function rowsFromCsv(text: string): CsvRows {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: 'The file needs a header row and at least one company' };
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/[_-]+/g, ' '));
  const index = Object.fromEntries(
    (Object.keys(COLUMNS) as Array<keyof ImportRow>).map((k) => [k, header.findIndex((h) => COLUMNS[k].includes(h))]),
  ) as Record<keyof ImportRow, number>;
  if (index.name === -1 || index.domain === -1) return { rows: [], error: 'The header row must include a company name column and a website or domain column' };
  const get = (r: string[], k: keyof ImportRow) => (index[k] === -1 ? '' : (r[index[k]] ?? '').trim());
  return {
    rows: table.slice(1).map((r, i) => ({
      line: i + 2,
      row: { name: get(r, 'name'), domain: get(r, 'domain'), category: get(r, 'category') || undefined, country: get(r, 'country') || undefined, notes: get(r, 'notes') || undefined },
    })),
    error: null,
  };
}

export type CandidateStatus = 'new' | 'existing' | 'repeat' | 'invalid';

export interface ImportCandidate {
  line: number;
  row: ImportRow;
  domain: string;
  status: CandidateStatus;
  note: string | null;
}

export function previewImport(rows: Array<{ line: number; row: ImportRow }>, existing: Map<string, string>): ImportCandidate[] {
  const seen = new Map<string, number>();
  return rows.map(({ line, row }) => {
    const domain = normalizeDomain(row.domain);
    if (!row.name.trim()) return { line, row, domain, status: 'invalid', note: 'Missing company name' };
    if (!DOMAIN_RE.test(domain)) return { line, row, domain, status: 'invalid', note: 'Not a valid website domain' };
    const known = existing.get(domain);
    if (known) return { line, row, domain, status: 'existing', note: `Already in the system as ${known}` };
    const first = seen.get(domain);
    if (first !== undefined) return { line, row, domain, status: 'repeat', note: `Same website as line ${first}` };
    seen.set(domain, line);
    return { line, row, domain, status: 'new', note: null };
  });
}
