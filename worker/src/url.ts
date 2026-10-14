export function normalizeDomain(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const host = new URL(withScheme).hostname.toLowerCase();
  return host.replace(/^www\./, "");
}

export function isSameSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function canonicalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|_pos|_sid|_ss|_psq|variant$)/i.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}
