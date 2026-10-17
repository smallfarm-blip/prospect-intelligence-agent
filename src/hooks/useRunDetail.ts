import { useCallback, useEffect, useState } from 'react';
import { loadRunDetail, signedUrls } from '@/lib/reviewApi';
import type { AnalysisRun, AssessmentOverride, ReadinessDecision, Review, RunDetail } from '@/lib/types';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: RunDetail; urls: Record<string, string> };

export function useRunDetail(run: AnalysisRun | null) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (!run) return;
    let active = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const detail = await loadRunDetail(run);
        const paths = [
          ...detail.images.map((i) => i.derived_path ?? i.source_path),
          ...detail.pages.flatMap((p) => [p.screenshot_path ?? '', p.unobstructed_screenshot_path ?? '']),
        ];
        const urls = await signedUrls(paths);
        if (active) setState({ status: 'ready', detail, urls });
      } catch (e) {
        if (active) setState({ status: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      active = false;
    };
  }, [run]);

  const addReview = useCallback((review: Review) => {
    setState((s) => (s.status === 'ready' ? { ...s, detail: { ...s.detail, reviews: [review, ...s.detail.reviews] } } : s));
  }, []);

  const addOverride = useCallback((o: AssessmentOverride) => {
    setState((s) => (s.status === 'ready' ? { ...s, detail: { ...s.detail, overrides: [o, ...s.detail.overrides] } } : s));
  }, []);

  const addReadiness = useCallback((r: ReadinessDecision) => {
    setState((s) => (s.status === 'ready' ? { ...s, detail: { ...s.detail, readiness: [r, ...s.detail.readiness] } } : s));
  }, []);

  return { state, addReview, addOverride, addReadiness };
}
