export interface RobotsRules {
  status: "parsed" | "absent" | "unreachable";
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

/** Extracts the rules that apply to a generic crawler (User-agent: *). */
export function parseRobots(text: string): Omit<RobotsRules, "status"> {
  const allow: string[] = [];
  const disallow: string[] = [];
  let crawlDelaySeconds: number | null = null;
  let groupAgents: string[] = [];
  let inRules = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      groupAgents.push(value.toLowerCase());
      continue;
    }
    inRules = true;
    if (!groupAgents.includes("*")) continue;
    if (key === "disallow" && value) disallow.push(value);
    else if (key === "allow" && value) allow.push(value);
    else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) crawlDelaySeconds = n;
    }
  }
  return { allow, disallow, crawlDelaySeconds };
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const pattern = body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; Allow wins ties (RFC 9309). */
export function isPathAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  if (rules.status === "absent") return true;
  if (rules.status === "unreachable") return false;
  let best: { length: number; allow: boolean } | null = null;
  for (const [list, allow] of [[rules.allow, true], [rules.disallow, false]] as const) {
    for (const rule of list) {
      if (!ruleMatches(rule, pathWithQuery)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && allow)) {
        best = { length: rule.length, allow };
      }
    }
  }
  return best ? best.allow : true;
}

/** RFC 9309: 4xx means no restrictions; 5xx or network failure means assume full disallow. */
export async function fetchRobots(domain: string, timeoutMs = 10_000): Promise<RobotsRules> {
  try {
    const res = await fetch(`https://${domain}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (res.status >= 400 && res.status < 500) {
      return { status: "absent", allow: [], disallow: [], crawlDelaySeconds: null };
    }
    if (!res.ok) return { status: "unreachable", allow: [], disallow: [], crawlDelaySeconds: null };
    return { status: "parsed", ...parseRobots(await res.text()) };
  } catch {
    return { status: "unreachable", allow: [], disallow: [], crawlDelaySeconds: null };
  }
}
