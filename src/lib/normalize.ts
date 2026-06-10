import { KEYWORD_WEIGHTS, WATCHED_ACCOUNTS } from "./defaults";
import type { AuxSignal, Signal } from "./types";

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

/**
 * Normalize a Hacker News Algolia hit (story or comment) into an aux signal.
 * Gate mirrors the GitHub one: must mention "codex" plus at least one more
 * watched keyword — HN is a noisy second-order venue, so it nudges only.
 */
export function normalizeHnHit(raw: unknown): AuxSignal | null {
  const hit = asRecord(raw);
  if (!hit) return null;

  const text = compactText(hit.title, hit.story_title, hit.story_text, hit.comment_text);
  const matchedKeywords = matchKeywords(text);

  if (!matchedKeywords.includes("codex") || matchedKeywords.length < 2) return null;

  const objectId = idValue(hit.objectID);
  const title = firstString(hit.title, hit.story_title) || "Hacker News item";

  return {
    id: stableId("hn", hit.objectID, hit.url),
    source: "hn",
    sourceLabel: "Hacker News",
    sourceWeight: 0.4,
    author: stringValue(hit.author),
    title,
    text,
    url:
      firstString(hit.url, hit.story_url) ||
      (objectId ? `https://news.ycombinator.com/item?id=${objectId}` : "https://news.ycombinator.com"),
    publishedAt: publishedAt(hit.created_at),
    matchedKeywords,
    strength: strengthFor(matchedKeywords),
    reason: `Hacker News discussion mentioned Codex keywords: ${keywordSummary(matchedKeywords)}.`
  };
}

/**
 * Normalize an OpenAI developer-forum (Discourse) topic into an aux signal.
 * Users report unexpected resets / new quota periods there directly, making it
 * the highest-quality community source. `extraText` carries matching post
 * blurbs from the same search response for extra keyword surface.
 */
export function normalizeForumTopic(raw: unknown, extraText: string = ""): AuxSignal | null {
  const topic = asRecord(raw);
  if (!topic) return null;

  const title = firstString(topic.title, topic.fancy_title);
  const text = compactText(title, extraText);
  const matchedKeywords = matchKeywords(text);

  if (!matchedKeywords.includes("codex") || matchedKeywords.length < 2) return null;

  const id = idValue(topic.id);
  if (!id) return null;
  const slug = stringValue(topic.slug);

  return {
    id: stableId("openai-forum", topic.id),
    source: "openai-forum",
    sourceLabel: "OpenAI Forum",
    sourceWeight: 0.55,
    title: title || "OpenAI forum topic",
    text,
    url: slug
      ? `https://community.openai.com/t/${slug}/${id}`
      : `https://community.openai.com/t/${id}`,
    publishedAt: publishedAt(topic.created_at, topic.bumped_at),
    matchedKeywords,
    strength: strengthFor(matchedKeywords),
    reason: `OpenAI forum topic mentioned Codex keywords: ${keywordSummary(matchedKeywords)}.`
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
