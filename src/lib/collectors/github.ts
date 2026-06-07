import { normalizeGithubIssue } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

const GITHUB_ISSUES_URL =
  "https://api.github.com/repos/openai/codex/issues?state=all&sort=updated&direction=desc&per_page=50";

export async function collectGithubSignals(): Promise<CollectorResult> {
  try {
    const response = await fetch(GITHUB_ISSUES_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      }
    });

    if (!response.ok) {
      return {
        status: { source: "github", ok: false, message: `GitHub collector failed with HTTP ${response.status}.` },
        signals: []
      };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return {
        status: { source: "github", ok: false, message: "GitHub collector returned an unexpected JSON shape." },
        signals: []
      };
    }

    const rows = payload;
    const signals = rows
      .map((row) => normalizeGithubIssue(row))
      .filter((signal): signal is Signal => Boolean(signal));
    const fetchedAt = new Date().toISOString();

    return {
      status: { source: "github", ok: true, message: `Fetched ${signals.length} GitHub signals.`, fetchedAt },
      signals
    };
  } catch (error) {
    return {
      status: { source: "github", ok: false, message: `GitHub collector failed: ${errorMessage(error)}` },
      signals: []
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
