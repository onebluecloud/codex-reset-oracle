import { normalizeForumTopic } from "../normalize";
import type { AuxCollectorResult } from "./hn";
import type { AuxSignal } from "../types";

// OpenAI's developer forum (Discourse) exposes anonymous JSON search. Users
// report unexpected resets / new quota periods there directly — the highest
// signal quality of the community sources. Some datacenter egress IPs are
// blocked by its CDN, so failures must degrade gracefully (aux failures never
// mark the forecast partial).
const FORUM_SEARCH_BASE = "https://community.openai.com/search.json?q=";
const QUERIES = ["codex reset order:latest", "codex quota order:latest"];

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LooseRecord;
}

async function fetchSearch(query: string): Promise<{ topics: unknown[]; posts: unknown[] } | null> {
  const response = await fetch(FORUM_SEARCH_BASE + encodeURIComponent(query), {
    headers: { accept: "application/json" }
  });
  if (!response.ok) return null;
  const payload = asRecord(await response.json());
  if (!payload) return null;
  return {
    topics: Array.isArray(payload.topics) ? payload.topics : [],
    posts: Array.isArray(payload.posts) ? payload.posts : []
  };
}

export async function collectForumSignals(): Promise<AuxCollectorResult> {
  try {
    // Each query degrades independently — one blocked/broken query must not
    // sink the other.
    const results = await Promise.all(
      QUERIES.map((query) => fetchSearch(query).catch(() => null))
    );
    if (results.every((result) => result === null)) {
      return {
        status: { source: "openai-forum", ok: false, message: "OpenAI forum search unreachable." },
        signals: []
      };
    }

    // Join post blurbs onto their topics for extra keyword surface, then
    // normalize each topic once (dedupe across the two queries by topic id).
    const blurbsByTopic = new Map<string, string[]>();
    const topicsById = new Map<string, unknown>();
    for (const result of results) {
      if (!result) continue;
      for (const rawPost of result.posts) {
        const post = asRecord(rawPost);
        const topicId = post?.topic_id;
        const blurb = typeof post?.blurb === "string" ? post.blurb : null;
        if (topicId === undefined || topicId === null || !blurb) continue;
        const key = String(topicId);
        const list = blurbsByTopic.get(key) ?? [];
        list.push(blurb);
        blurbsByTopic.set(key, list);
      }
      for (const rawTopic of result.topics) {
        const topic = asRecord(rawTopic);
        if (topic?.id === undefined || topic.id === null) continue;
        topicsById.set(String(topic.id), rawTopic);
      }
    }

    const signals: AuxSignal[] = [];
    for (const [topicId, rawTopic] of topicsById) {
      const signal = normalizeForumTopic(rawTopic, (blurbsByTopic.get(topicId) ?? []).join(" "));
      if (signal) signals.push(signal);
    }

    return {
      status: {
        source: "openai-forum",
        ok: true,
        message: `Fetched ${signals.length} OpenAI forum signals.`,
        fetchedAt: new Date().toISOString()
      },
      signals
    };
  } catch (error) {
    return {
      status: {
        source: "openai-forum",
        ok: false,
        message: `OpenAI forum collector failed: ${errorMessage(error)}`
      },
      signals: []
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
