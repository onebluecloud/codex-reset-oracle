import { afterEach, describe, expect, it, vi } from "vitest";

import { apifyTweetFixture } from "@/test/fixtures/apify";
import { githubIssueFixture } from "@/test/fixtures/github";
import { statusIncidentFixture } from "@/test/fixtures/status";
import { collectApifySignals } from "./apify";
import { collectGithubSignals } from "./github";
import { collectHnSignals } from "./hn";
import { collectForumSignals } from "./openai-forum";
import { collectOpenAIStatusSignals } from "./openai-status";
import { collectResetRadarSignals } from "./reset-radar";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("collectApifySignals", () => {
  it("skips when APIFY_TOKEN is missing", async () => {
    const result = await collectApifySignals({ token: "", actorId: "apidojo/twitter-scraper-lite" });

    expect(result.status.ok).toBe(false);
    expect(result.status.message).toMatch(/APIFY_TOKEN/);
    expect(result.signals).toEqual([]);
  });

  it("fetches Apify rows and normalizes X signals", async () => {
    const token = "secret-token";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([apifyTweetFixture]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectApifySignals({ token, actorId: "owner/nested/actor" });

    expect(result.status.ok).toBe(true);
    expect(result.signals[0]?.source).toBe("x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.apify.com/v2/acts/owner~nested~actor/run-sync-get-dataset-items?clean=true&format=json&maxTotalChargeUsd=1"
    );
    expect(url).not.toContain(token);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    });
    expect(init.body).not.toContain(token);
    expect(JSON.parse(init.body as string)).toMatchObject({
      sort: "Latest",
      maxItems: 80,
      includeSearchTerms: true
    });
  });

  it("sanitizes Apify request errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failed with Bearer token")));

    const result = await collectApifySignals({ token: "token", actorId: "actor/id" });

    expect(result.status.ok).toBe(false);
    expect(result.status.message).toBe("Apify request failed.");
    expect(result.status.message).not.toMatch(/Bearer|token/);
    expect(result.signals).toEqual([]);
  });

  it("fails when Apify returns a non-array payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [apifyTweetFixture] })));

    const result = await collectApifySignals({ token: "token", actorId: "actor/id" });

    expect(result.status.ok).toBe(false);
    expect(result.signals).toEqual([]);
  });
});

describe("collectOpenAIStatusSignals", () => {
  it("fetches OpenAI Status incidents and normalizes signals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ incidents: [statusIncidentFixture] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectOpenAIStatusSignals();

    expect(result.status.ok).toBe(true);
    expect(result.signals[0]?.source).toBe("openai-status");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://status.openai.com/api/v2/incidents.json", {
      headers: {
        accept: "application/json"
      }
    });
  });

  it("fails when OpenAI Status returns a payload without an incidents array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ incidents: {} })));

    const result = await collectOpenAIStatusSignals();

    expect(result.status.ok).toBe(false);
    expect(result.signals).toEqual([]);
  });
});

describe("collectGithubSignals", () => {
  it("fetches GitHub issues and normalizes signals without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([githubIssueFixture]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectGithubSignals();

    expect(result.status.ok).toBe(true);
    expect(result.signals[0]?.source).toBe("github");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/openai/codex/issues?state=all&sort=updated&direction=desc&per_page=50"
    );
    expect(init.headers).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    });
  });

  it("sends an Authorization header when GITHUB_TOKEN is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_example_token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([githubIssueFixture]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectGithubSignals();

    expect(result.status.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer ghp_example_token"
    });
  });

  it("fails when GitHub returns a non-array payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [githubIssueFixture] })));

    const result = await collectGithubSignals();

    expect(result.status.ok).toBe(false);
    expect(result.signals).toEqual([]);
  });
});

describe("collectResetRadarSignals", () => {
  it("fetches Codex Reset Radar current.json and normalizes prediction signals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        checked_at: "2026-06-07T08:28:49.554447+08:00",
        status: "none",
        window_open: false,
        message: "暂无正式速蹬窗口",
        links: { html: "index.html" },
        prediction: {
          level: "medium",
          probability_24h: 0.26,
          probability_48h: 0.36,
          expected_window: "未来 24-48 小时",
          reasoning_summary:
            "当前没有官方开启窗口，也没有 Tibo/Sam/OpenAI 明确暗示下一次 Codex reset。",
          signal_summary_24h: {
            candidate_total: 9,
            observation_counts: {
              official_x: 0,
              community_x: 12,
              openai_status: 1
            }
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectResetRadarSignals();

    expect(result.status.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      source: "codex-reset-radar",
      sourceLabel: "Codex Reset Radar",
      title: "Codex Reset Radar: medium probability",
      matchedKeywords: ["codex", "reset"]
    });
    expect(result.signals[0]?.strength).toBeCloseTo(0.26);
    expect(result.signals[0]?.reason).toContain("24h 26%");
    expect(fetchMock).toHaveBeenCalledWith("https://codex-reset-radar.pages.dev/current.json", {
      headers: { accept: "application/json" }
    });
  });

  it("fails when Codex Reset Radar returns an unexpected JSON shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ prediction: null })));

    const result = await collectResetRadarSignals();

    expect(result.status.ok).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("retries transient Codex Reset Radar request failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValue(
        jsonResponse({
          checked_at: "2026-06-07T11:27:49.811587+08:00",
          prediction: {
            level: "medium",
            probability_24h: 0.25,
            probability_48h: 0.35
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectResetRadarSignals();

    expect(result.status.ok).toBe(true);
    expect(result.signals[0]?.strength).toBeCloseTo(0.25);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("collectHnSignals", () => {
  const NOW = new Date("2026-06-10T00:00:00.000Z");
  const hnHit = {
    objectID: "44001234",
    title: "Codex weekly quota reset happened again",
    url: "https://example.com/codex-post",
    author: "pg2",
    created_at: "2026-06-09T12:00:00.000Z"
  };

  it("fetches recent Algolia hits and normalizes aux signals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [hnHit] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectHnSignals(NOW);

    expect(result.status).toMatchObject({ source: "hn", ok: true });
    expect(result.signals[0]?.source).toBe("hn");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("hn.algolia.com/api/v1/search_by_date");
    expect(url).toContain("query=codex");
    // 72h freshness cutoff derived from `now`.
    expect(url).toContain(`created_at_i>${Math.floor(NOW.getTime() / 1000) - 72 * 3600}`);
  });

  it("fails softly on HTTP errors and bad shapes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })));
    expect((await collectHnSignals(NOW)).status.ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
    expect((await collectHnSignals(NOW)).status.ok).toBe(false);
  });
});

describe("collectForumSignals", () => {
  const forumPayload = {
    topics: [
      {
        id: 987654,
        title: "Questions about an unexpected Codex usage reset",
        slug: "questions-about-an-unexpected-codex-usage-reset",
        created_at: "2026-06-04T03:00:00.000Z"
      }
    ],
    posts: [{ id: 1, topic_id: 987654, blurb: "my codex quota reset early", created_at: "2026-06-04T03:00:00.000Z" }]
  };

  it("queries the Discourse search JSON and normalizes topics with blurbs", async () => {
    // Fresh Response per call — a Response body can only be consumed once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(forumPayload)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectForumSignals();

    expect(result.status).toMatchObject({ source: "openai-forum", ok: true });
    expect(result.signals).toHaveLength(1); // deduped across the two queries
    expect(result.signals[0]).toMatchObject({
      source: "openai-forum",
      url: "https://community.openai.com/t/questions-about-an-unexpected-codex-usage-reset/987654"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string];
    expect(firstUrl).toContain("community.openai.com/search.json?q=");
  });

  it("reports failure only when every query is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, { status: 403 })))
    );
    const blocked = await collectForumSignals();
    expect(blocked.status.ok).toBe(false);
    expect(blocked.signals).toEqual([]);

    // One query blocked, one fine → still ok.
    const mixed = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(forumPayload));
    vi.stubGlobal("fetch", mixed);
    const partial = await collectForumSignals();
    expect(partial.status.ok).toBe(true);
    expect(partial.signals).toHaveLength(1);
  });
});
