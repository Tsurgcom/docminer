import { LINE_SPLIT_REGEX } from "./constants";
import { logger } from "./logger";
import { fetchWithTimeout } from "./network";
import type { CliOptions, RobotsPolicy } from "./types";

export function buildAllowAllPolicy(): RobotsPolicy {
  return {
    isAllowed: () => true,
    source: "allow-all",
  };
}

export function normalizeRulePath(rule: string): string {
  if (!rule.startsWith("/")) {
    return `/${rule}`;
  }
  return rule;
}

export function selectAgentPolicy(
  rules: Map<
    string,
    { allow: string[]; disallow: string[]; crawlDelayMs?: number }
  >,
  userAgent: string
): { allow: string[]; disallow: string[]; crawlDelayMs?: number } | undefined {
  const lowerUA = userAgent.toLowerCase();
  if (rules.has(lowerUA)) {
    return rules.get(lowerUA);
  }
  for (const [agent, policy] of rules.entries()) {
    if (agent !== "*" && lowerUA.includes(agent)) {
      return policy;
    }
  }
  return rules.get("*");
}

export function parseRobotsTxt(
  robotsText: string,
  userAgent: string
): RobotsPolicy {
  const rules = new Map<
    string,
    { allow: string[]; disallow: string[]; crawlDelayMs?: number }
  >();
  let currentAgents = new Set<string>();

  const ensureEntry = (agent: string): void => {
    if (!rules.has(agent)) {
      rules.set(agent, { allow: [], disallow: [] });
    }
  };

  const applyToAgents = (
    handler: (entry: {
      allow: string[];
      disallow: string[];
      crawlDelayMs?: number;
    }) => void
  ): void => {
    if (currentAgents.size === 0) {
      currentAgents.add("*");
    }
    for (const agent of currentAgents) {
      ensureEntry(agent);
      const entry = rules.get(agent);
      if (entry) {
        handler(entry);
      }
    }
  };

  const lines = robotsText.split(LINE_SPLIT_REGEX);
  for (const rawLine of lines) {
    const line = rawLine.split("#", 1)[0]?.trim();
    if (!line) {
      continue;
    }
    const [directiveRaw = "", valueRaw = ""] = line.split(":", 2);
    const directive = directiveRaw.trim().toLowerCase();
    const value = valueRaw.trim();

    if (directive === "user-agent") {
      const agent = value.toLowerCase();
      currentAgents = new Set([agent]);
      ensureEntry(agent);
      continue;
    }

    if (directive === "allow") {
      if (value) {
        applyToAgents((entry) => {
          entry.allow.push(normalizeRulePath(value));
        });
      }
      continue;
    }

    if (directive === "disallow") {
      if (value) {
        applyToAgents((entry) => {
          entry.disallow.push(normalizeRulePath(value));
        });
      }
      continue;
    }

    if (directive === "crawl-delay") {
      const delaySeconds = Number.parseFloat(value);
      if (Number.isFinite(delaySeconds)) {
        const delayMs = delaySeconds * 1000;
        applyToAgents((entry) => {
          entry.crawlDelayMs = delayMs;
        });
      }
    }
  }

  const policy = selectAgentPolicy(rules, userAgent);
  if (!policy) {
    return buildAllowAllPolicy();
  }

  const allowRules = policy.allow;
  const disallowRules = policy.disallow;
  const evaluate = (pathname: string): boolean => {
    let longestAllow = "";
    let longestDisallow = "";
    for (const rule of allowRules) {
      if (pathname.startsWith(rule) && rule.length > longestAllow.length) {
        longestAllow = rule;
      }
    }
    for (const rule of disallowRules) {
      if (pathname.startsWith(rule) && rule.length > longestDisallow.length) {
        longestDisallow = rule;
      }
    }
    if (longestAllow.length === 0 && longestDisallow.length === 0) {
      return true;
    }
    if (longestAllow.length >= longestDisallow.length) {
      return true;
    }
    return false;
  };

  return {
    isAllowed: evaluate,
    crawlDelayMs: policy.crawlDelayMs,
    source: "robots.txt",
  };
}

export async function loadRobotsPolicy(
  baseUrl: URL,
  options: Pick<CliOptions, "timeoutMs" | "userAgent" | "verbose">
): Promise<RobotsPolicy> {
  const robotsUrl = new URL("/robots.txt", baseUrl.origin).toString();
  try {
    const text = await fetchWithTimeout(
      robotsUrl,
      options.timeoutMs,
      options.userAgent
    );
    logger.debug(`Loaded robots.txt from ${robotsUrl}`);
    return parseRobotsTxt(text, options.userAgent);
  } catch (error) {
    logger.debug(
      `Could not load robots.txt from ${robotsUrl}: ${String(error)}`
    );
    return buildAllowAllPolicy();
  }
}
