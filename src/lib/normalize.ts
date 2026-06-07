import { KEYWORD_WEIGHTS, WATCHED_ACCOUNTS } from "./defaults";
import type { Signal } from "./types";

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LooseRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function idValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function stableId(prefix: string, ...values: unknown[]): string {
  const candidate = values.map(idValue).find((value) => value);
  return `${prefix}:${candidate ?? "unknown"}`;
}

function publishedAt(...values: unknown[]): string {
  const candidate = values.map(stringValue).find((value) => value);
  if (!candidate) return new Date(0).toISOString();

  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? candidate : date.toISOString();
}

function compactText(...values: unknown[]): string {
  return values
    .map(stringValue)
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function firstString(...values: unknown[]): string {
  return values.map(stringValue).find((value) => value) ?? "";
}

function keywordSummary(keywords: string[]): string {
  return keywords.join(", ");
}

export function matchKeywords(text: string): string[] {
  const tokens = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return Object.keys(KEYWORD_WEIGHTS).filter((keyword) => tokens.has(keyword));
}

export function strengthFor(keywords: string[]): number {
  const total = keywords.reduce((sum, keyword) => sum + (KEYWORD_WEIGHTS[keyword] ?? 0), 0);
  return Math.max(0.1, Math.min(1, total));
}

export function accountWeight(handle: string | undefined): number {
  if (!handle) return 0.4;

  const normalizedHandle = handle.replace(/^@/, "").toLowerCase();
  return WATCHED_ACCOUNTS.find((account) => account.handle.toLowerCase() === normalizedHandle)?.weight ?? 0.4;
}

export function normalizeApifyTweet(raw: unknown): Signal | null {
  const tweet = asRecord(raw);
  if (!tweet) return null;

  const author = asRecord(tweet.author);
  const handle = firstString(author?.userName, author?.username, tweet.username).replace(/^@/, "");
  const text = firstString(tweet.text, tweet.fullText);
  const matchedKeywords = matchKeywords(text);

  if (!matchedKeywords.includes("codex") || matchedKeywords.length < 2) return null;

  const id = stableId("x", tweet.id, tweet.url);
  const url =
    firstString(tweet.url) ||
    (handle && idValue(tweet.id) ? `https://x.com/${handle}/status/${idValue(tweet.id)}` : "https://x.com");

  return {
    id,
    source: "x",
    sourceLabel: "X/Twitter",
    sourceWeight: accountWeight(handle),
    author: handle ? `@${handle}` : undefined,
    title: handle ? `@${handle} on X` : "X post",
    text,
    url,
    publishedAt: publishedAt(tweet.createdAt),
    matchedKeywords,
    strength: strengthFor(matchedKeywords),
    reason: `Watched X account ${handle ? `@${handle}` : "source"} mentioned Codex keywords: ${keywordSummary(
      matchedKeywords
    )}.`
  };
}

export function normalizeStatusIncident(raw: unknown): Signal | null {
  const incident = asRecord(raw);
  if (!incident) return null;

  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : incident.incidentUpdates;
  const updateBodies = Array.isArray(updates)
    ? updates.map((update) => stringValue(asRecord(update)?.body)).filter((body): body is string => Boolean(body))
    : [];
  const text = compactText(incident.name, incident.status, incident.impact, ...updateBodies);
  const matchedKeywords = matchKeywords(text);

  if (!matchedKeywords.includes("codex")) return null;

  const title = firstString(incident.name) || "OpenAI status incident";

  return {
    id: stableId("status", incident.id, incident.name),
    source: "openai-status",
    sourceLabel: "OpenAI Status",
    sourceWeight: 0.9,
    title,
    text,
    url: firstString(incident.shortlink, incident.shortLink, incident.url) || "https://status.openai.com",
    publishedAt: publishedAt(incident.updated_at, incident.updatedAt, incident.created_at, incident.createdAt),
    matchedKeywords,
    strength: strengthFor(matchedKeywords),
    reason: `OpenAI Status incident mentioned Codex keywords: ${keywordSummary(matchedKeywords)}.`
  };
}

export function normalizeGithubIssue(raw: unknown): Signal | null {
  const issue = asRecord(raw);
  if (!issue || issue.pull_request !== undefined) return null;

  const text = compactText(issue.title, issue.body);
  const matchedKeywords = matchKeywords(text);

  if (!matchedKeywords.includes("codex") || matchedKeywords.length < 2) return null;

  const user = asRecord(issue.user);
  const number = idValue(issue.number);
  const title = firstString(issue.title) || "Untitled issue";

  return {
    id: stableId("github", issue.id, issue.number, issue.html_url),
    source: "github",
    sourceLabel: "GitHub Issues",
    sourceWeight: 0.45,
    author: stringValue(user?.login),
    title: number ? `#${number} ${title}` : title,
    text,
    url: firstString(issue.html_url, issue.url) || "https://github.com/openai/codex/issues",
    publishedAt: publishedAt(issue.updated_at, issue.updatedAt, issue.created_at, issue.createdAt),
    matchedKeywords,
    strength: strengthFor(matchedKeywords),
    reason: `GitHub issue mentioned Codex keywords: ${keywordSummary(matchedKeywords)}.`
  };
}
