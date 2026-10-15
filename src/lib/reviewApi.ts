import { SCREENSHOT_BUCKET, supabase } from '@/lib/supabase';
import type { AnalysisRun, Decision, RejectionReason, Review, RunDetail } from '@/lib/types';

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`Could not load ${what}`);
  return res.data;
}

export async function isReviewer(userId: string): Promise<boolean> {
  const res = await supabase.from('reviewers').select('user_id').eq('user_id', userId).maybeSingle();
  if (res.error) throw new Error(`Could not check reviewer access: ${res.error.message}`);
  return !!res.data;
}

export async function listRuns(): Promise<AnalysisRun[]> {
  return must(
    await supabase.from('analysis_runs').select('*, companies(name, canonical_domain)').order('started_at', { ascending: false }).limit(200),
    'analysis runs',
  ) as AnalysisRun[];
}

export async function loadRunDetail(run: AnalysisRun): Promise<RunDetail> {
  const [calls, images, findings] = await Promise.all([
    supabase.from('analysis_model_calls').select('*').eq('analysis_run_id', run.id).order('created_at'),
    supabase.from('analysis_images').select('*').eq('analysis_run_id', run.id).order('ref'),
    supabase.from('analysis_findings').select('*').eq('analysis_run_id', run.id).order('generated_at'),
  ]);
  const findingRows = must(findings, 'findings') as RunDetail['findings'];
  const ids = findingRows.map((f) => f.id);
  const [evidence, verifications, reviews] = ids.length
    ? await Promise.all([
        supabase.from('analysis_finding_evidence').select('*').in('finding_id', ids),
        supabase.from('analysis_verifications').select('*').in('finding_id', ids).order('created_at', { ascending: false }),
        supabase.from('finding_reviews').select('*').in('finding_id', ids).order('created_at', { ascending: false }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const imageRows = must(images, 'images') as RunDetail['images'];
  const pageIds = [...new Set(imageRows.map((i) => i.page_evidence_id))];
  const pages = pageIds.length
    ? must(
        await supabase
          .from('page_evidence')
          .select('id, page_type, page_slot, viewport_name, final_url, screenshot_path, unobstructed_screenshot_path, overlay_dismissal_status')
          .in('id', pageIds),
        'page evidence',
      )
    : [];
  return {
    run,
    calls: must(calls, 'model calls') as RunDetail['calls'],
    images: imageRows,
    findings: findingRows,
    evidence: must(evidence, 'evidence links') as RunDetail['evidence'],
    verifications: must(verifications, 'verifications') as RunDetail['verifications'],
    reviews: must(reviews, 'reviews') as RunDetail['reviews'],
    pages: pages as RunDetail['pages'],
  };
}

/** Short-lived links to private screenshots; the bucket itself is never public. */
export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return {};
  const res = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrls(unique, 3600);
  if (res.error) throw new Error(`Could not load screenshots: ${res.error.message}`);
  const out: Record<string, string> = {};
  for (const item of res.data ?? []) if (item.path && item.signedUrl && !item.error) out[item.path] = item.signedUrl;
  return out;
}

export async function submitReview(input: { findingId: string; decision: Decision; rejectionReason: RejectionReason | null; notes: string }): Promise<Review> {
  return must(
    await supabase
      .from('finding_reviews')
      .insert({ finding_id: input.findingId, decision: input.decision, rejection_reason: input.decision === 'rejected' ? input.rejectionReason : null, notes: input.notes.trim() })
      .select('*')
      .single(),
    'saved review',
  ) as Review;
}
