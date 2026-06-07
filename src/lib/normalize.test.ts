import { describe, expect, it } from "vitest";

import { normalizeApifyTweet, normalizeGithubIssue, normalizeStatusIncident } from "./normalize";
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
