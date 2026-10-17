import { useState } from 'react';
import { Copy, ImageOff, Maximize2, X } from 'lucide-react';
import type { CitedImage } from '@/lib/findingView';
import type { PageEvidence } from '@/lib/types';
import { Badge } from '@/components/ui';
import { humanize } from '@/lib/format';
import { CAPTURE_STATE_TERMS, captureStateLabel } from '@/lib/captureStates';

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/80 p-6 backdrop-blur-sm" onClick={onClose}>
      <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Close">
        <X className="h-5 w-5" />
      </button>
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
    </div>
  );
}

function Missing({ label }: { label: string }) {
  return (
    <div className="flex aspect-video items-center justify-center gap-2 rounded-lg border border-dashed border-ink-200 bg-ink-50 text-xs text-ink-400">
      <ImageOff className="h-4 w-4" /> {label}
    </div>
  );
}

export function CitedImageView({ cited, url }: { cited: CitedImage; url: string | null }) {
  const [zoom, setZoom] = useState(false);
  const { image, pages, regions, factIds } = cited;
  const page = pages[0];
  const shared = pages.length > 1;
  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-medium text-ink-700">{image.ref}</span>
        <span title={CAPTURE_STATE_TERMS[image.capture_state]?.meaning}>
          <Badge tone="secondary">{captureStateLabel(image.capture_state)}</Badge>
        </span>
        {pages.map((p) => <Badge key={p.id}>{p.page_slot} / {p.viewport_name}</Badge>)}
        <span className="text-xs text-ink-500">supports {factIds.join(', ')}</span>
      </div>
      {shared && (
        <p className="flex items-start gap-1.5 rounded-md bg-warning-50 px-2 py-1.5 text-xs text-warning-700">
          <Copy className="mt-0.5 h-3 w-3 shrink-0" />
          Identical screenshot captured for {pages.length} pages. On its own it cannot show which page it belongs to.
        </p>
      )}
      {url ? (
        <div className="group relative overflow-hidden rounded-lg border border-ink-200 bg-ink-100">
          <img src={url} alt={`Screenshot ${image.ref}`} className="block w-full" loading="lazy" />
          {regions.map((r, n) => (
            <div
              key={n}
              className="pointer-events-none absolute rounded-sm border-2 border-accent-500 bg-accent-400/10 shadow-[0_0_0_9999px_rgba(27,26,24,0.25)]"
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }}
            >
              <span className="absolute -top-5 left-0 rounded bg-accent-600 px-1 font-mono text-[10px] text-white">{r.factId}</span>
            </div>
          ))}
          <button onClick={() => setZoom(true)} className="absolute right-2 top-2 rounded-md bg-white/90 p-1.5 text-ink-700 opacity-0 shadow transition group-hover:opacity-100" aria-label="Enlarge">
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <Missing label="Screenshot unavailable" />
      )}
      {page?.final_url && <figcaption className="truncate font-mono text-xs text-ink-400">{page.final_url}</figcaption>}
      {zoom && url && <Lightbox src={url} alt={image.ref} onClose={() => setZoom(false)} />}
    </figure>
  );
}

export function StateComparison({ page, urls }: { page: PageEvidence; urls: Record<string, string> }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const shots = [
    { label: captureStateLabel('initial_viewport'), path: page.screenshot_path },
    { label: captureStateLabel('after_overlay_dismissal'), path: page.unobstructed_screenshot_path },
  ];
  return (
    <div className="rounded-lg border border-ink-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink-800">{humanize(page.page_slot)} / {page.viewport_name}</p>
        {page.overlay_dismissal_status && <Badge tone="neutral">Recorded pop-up status: {humanize(page.overlay_dismissal_status)}</Badge>}
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {shots.map((s) => {
          const url = s.path ? urls[s.path] : null;
          return (
            <div key={s.label} className="space-y-1">
              <p className="label">{s.label}</p>
              {url ? (
                <button onClick={() => setZoom(url)} className="block w-full overflow-hidden rounded-lg border border-ink-200 transition hover:shadow-md">
                  <img src={url} alt={s.label} className="max-h-96 w-full object-cover object-top" loading="lazy" />
                </button>
              ) : (
                <Missing label={s.path ? 'Screenshot unavailable' : 'No screenshot for this state'} />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-500">Trust the screenshots over the recorded status if they disagree.</p>
      {zoom && <Lightbox src={zoom} alt="Screenshot" onClose={() => setZoom(null)} />}
    </div>
  );
}
