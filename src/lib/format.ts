import type { QuoteKind } from '@/lib/types';

export const QUOTE_KIND_LABELS: Record<QuoteKind, string> = {
  page_text_verbatim: 'Quoted from page text',
  page_text_labels: 'Separate labels from page text',
  screenshot_verbatim: 'Read from screenshot, checked by verifier',
  screenshot_labels: 'Separate labels read from screenshot, checked by verifier',
};

export function usd(n: number | null | undefined, digits = 4): string {
  return n == null ? '-' : `$${Number(n).toFixed(digits)}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const PROVIDER_NAME: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };

export function providerName(p: string): string {
  return PROVIDER_NAME[p] ?? humanize(p);
}
