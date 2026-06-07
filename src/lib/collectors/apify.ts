import { WATCHED_ACCOUNTS } from "../defaults";
import { normalizeApifyTweet } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

const DEFAULT_ACTOR_ID = "apidojo/twitter-scraper-lite";
const SEARCH_TERMS = ["codex reset", "codex quota", "codex limit", "codex capacity", "codex usage"];

export async function collectApifySignals(options: { token?: string; actorId?: string }): Promise<CollectorResult> {
  if (!options.token) {
    return {
      status: { source: "x", ok: false, message: "APIFY_TOKEN is missing." },
      signals: []
    };
  }

  const actorId = options.actorId?.trim() || DEFAULT_ACTOR_ID;
  const actorPathSegment = encodeURIComponent(actorId.replace(/\//g, "~"));
  const url = `https://api.apify.com/v2/acts/${actorPathSegment}/run-sync-get-dataset-items?clean=true&format=json&maxTotalChargeUsd=1`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`
      },
      body: JSON.stringify({
        twitterHandles: WATCHED_ACCOUNTS.map((account) => account.handle),
        searchTerms: SEARCH_TERMS,
        sort: "Latest",
        maxItems: 80,
        includeSearchTerms: true
      })
    });

    if (!response.ok) {
      return {
        status: { source: "x", ok: false, message: `Apify collector failed with HTTP ${response.status}.` },
        signals: []
      };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return {
        status: { source: "x", ok: false, message: "Apify collector returned an unexpected JSON shape." },
        signals: []
      };
    }

    const rows = payload;
    const signals = rows
      .map((row) => normalizeApifyTweet(row))
      .filter((signal): signal is Signal => Boolean(signal));
    const fetchedAt = new Date().toISOString();

    return {
      status: { source: "x", ok: true, message: `Fetched ${signals.length} X signals.`, fetchedAt },
      signals
    };
  } catch {
    return {
      status: { source: "x", ok: false, message: "Apify request failed." },
      signals: []
    };
  }
}
