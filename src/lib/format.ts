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
