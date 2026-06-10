import { describe, expect, it } from "vitest";

import {
  normalizeApifyTweet,
  normalizeForumTopic,
  normalizeGithubIssue,
  normalizeHnHit,
  normalizeStatusIncident
} from "./normalize";
import { apifyTweetFixture } from "@/test/fixtures/apify";
import { githubIssueFixture, unrelatedGithubIssueFixture } from "@/test/fixtures/github";
import { statusIncidentFixture } from "@/test/fixtures/status";

describe("normalizeApifyTweet", () => {
  it("normalizes watched Codex reset tweets from Apify", () => {
    const signal = normalizeApifyTweet(apifyTweetFixture);

    expect(signal).not.toBeNull();
    expect(signal?.source).toBe("x");
    expect(signal?.sourceLabel).toBe("X/Twitter");
    expect(signal?.author).toBe("@thsottiaux");
    expect(signal?.matchedKeywords).toContain("reset");
    expect(signal?.sourceWeight).toBeGreaterThan(0.9);
  });

  it("ignores tweets where reset only appears inside another word", () => {
    expect(
      normalizeApifyTweet({
        ...apifyTweetFixture,
        text: "Codex preset panel is available"
      })
    ).toBeNull();
  });
});

describe("normalizeStatusIncident", () => {
  it("normalizes Codex status incidents", () => {
    const signal = normalizeStatusIncident(statusIncidentFixture);

    expect(signal).not.toBeNull();
    expect(signal?.source).toBe("openai-status");
    expect(signal?.matchedKeywords).toContain("codex");
    expect(signal?.url).toMatch(/status\.openai\.com|stspg\.io/);
  });
});

describe("normalizeGithubIssue", () => {
  it("normalizes Codex quota issues from GitHub", () => {
    const signal = normalizeGithubIssue(githubIssueFixture);

    expect(signal).not.toBeNull();
    expect(signal?.source).toBe("github");
    expect(signal?.matchedKeywords).toContain("quota");
    expect(signal?.reason).toMatch(/GitHub/);
  });

  it("ignores unrelated GitHub issues", () => {
    expect(normalizeGithubIssue(unrelatedGithubIssueFixture)).toBeNull();
  });

  it("ignores GitHub issues where limit only appears inside another word", () => {
    expect(
      normalizeGithubIssue({
        ...githubIssueFixture,
        title: "Codex unlimited mode question",
        body: "How does the app work?"
      })
    ).toBeNull();
  });
});

describe("normalizeHnHit", () => {
  const hnStoryFixture = {
    objectID: "44001234",
    title: "Codex weekly quota reset happened again",
    url: "https://example.com/codex-post",
    author: "pg2",
    created_at: "2026-06-09T12:00:00.000Z"
  };

  it("normalizes Codex quota stories into aux signals", () => {
    const signal = normalizeHnHit(hnStoryFixture);

    expect(signal).not.toBeNull();
    expect(signal?.source).toBe("hn");
    expect(signal?.sourceLabel).toBe("Hacker News");
    expect(signal?.matchedKeywords).toEqual(expect.arrayContaining(["codex", "quota", "reset"]));
    expect(signal?.url).toBe("https://example.com/codex-post");
  });

  it("falls back to the HN item URL and story_title for comments", () => {
    const signal = normalizeHnHit({
      objectID: "44009999",
      story_title: "Codex limits discussion",
      comment_text: "My codex quota reset early this morning.",
      author: "tptacek",
      created_at: "2026-06-09T12:00:00.000Z"
    });

    expect(signal).not.toBeNull();
    expect(signal?.title).toBe("Codex limits discussion");
    expect(signal?.url).toBe("https://news.ycombinator.com/item?id=44009999");
  });

  it("rejects hits without codex plus a second keyword", () => {
    expect(normalizeHnHit({ ...hnStoryFixture, title: "Codex is neat" })).toBeNull();
    expect(normalizeHnHit({ ...hnStoryFixture, title: "Quota reset on some service" })).toBeNull();
    expect(normalizeHnHit(null)).toBeNull();
  });
});

describe("normalizeForumTopic", () => {
  const forumTopicFixture = {
    id: 987654,
    title: "Questions about an unexpected Codex usage reset",
    slug: "questions-about-an-unexpected-codex-usage-reset",
    created_at: "2026-06-04T03:00:00.000Z"
  };

  it("normalizes forum topics reporting resets", () => {
    const signal = normalizeForumTopic(forumTopicFixture);

    expect(signal).not.toBeNull();
    expect(signal?.source).toBe("openai-forum");
    expect(signal?.sourceLabel).toBe("OpenAI Forum");
    expect(signal?.url).toBe(
      "https://community.openai.com/t/questions-about-an-unexpected-codex-usage-reset/987654"
    );
    expect(signal?.matchedKeywords).toEqual(expect.arrayContaining(["codex", "reset", "usage"]));
  });

  it("uses post blurbs as extra keyword surface", () => {
    const signal = normalizeForumTopic(
      { ...forumTopicFixture, title: "Codex question" },
      "my weekly quota reset out of nowhere"
    );

    expect(signal).not.toBeNull();
    expect(signal?.matchedKeywords).toEqual(expect.arrayContaining(["codex", "quota", "reset"]));
  });

  it("rejects topics without codex plus a second keyword, or without an id", () => {
    expect(normalizeForumTopic({ ...forumTopicFixture, title: "Codex is great" })).toBeNull();
    expect(normalizeForumTopic({ title: "Codex quota reset", created_at: "2026-06-04T03:00:00.000Z" })).toBeNull();
    expect(normalizeForumTopic(null)).toBeNull();
  });
});
