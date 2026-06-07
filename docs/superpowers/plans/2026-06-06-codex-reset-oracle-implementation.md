# Codex Reset Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prepare a public GitHub-ready local web app that automatically forecasts Codex reset likelihood from Apify X/Twitter, OpenAI Status, and GitHub signals.

**Architecture:** A Next.js App Router project hosts a server-side snapshot API and a client dashboard. Collectors normalize source data into shared signal objects; a deterministic scorer turns those signals into an explainable forecast. The app stores only a local latest-snapshot cache and never commits tokens or fetched raw datasets.

**Tech Stack:** Next.js, React, TypeScript, Vitest, Testing Library, Playwright, GitHub Actions.

---

## File Structure

- Create `package.json`: project scripts and dependencies.
- Create `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`: tool configuration.
- Create `.gitignore`, `.env.example`, `README.md`, `LICENSE`: public repo hygiene.
- Create `.github/workflows/ci.yml`: public CI.
- Create `src/test/setup.ts`: Vitest DOM matcher setup.
- Create `src/lib/types.ts`: shared source, signal, forecast, and collector types.
- Create `src/lib/defaults.ts`: watched accounts, keywords, weights, refresh constants.
- Create `src/lib/scoring.ts`: deterministic score calculation.
- Create `src/lib/normalize.ts`: helpers that turn raw collector records into `Signal`.
- Create `src/lib/collectors/apify.ts`: Apify actor integration for X/Twitter.
- Create `src/lib/collectors/openai-status.ts`: OpenAI Status incident collector.
- Create `src/lib/collectors/github.ts`: GitHub issue collector.
- Create `src/lib/snapshot.ts`: orchestration, cache freshness, collector failure handling.
- Create `src/app/api/snapshot/route.ts`: JSON API for cached or refreshed forecast snapshots.
- Create `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`: dashboard app shell.
- Create `src/components/ForecastDashboard.tsx`: interactive client dashboard.
- Create `src/test/fixtures/*.ts`: stable fixture payloads for collectors and scoring.
- Create `src/**/*.test.ts` and `src/components/*.test.tsx`: focused tests.
- Create `tests/dashboard.spec.ts`: browser smoke verification.

---

### Task 1: Project Scaffold And Public Repo Hygiene

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.mjs`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `eslint.config.mjs`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`
- Create: `LICENSE`
- Create: `.github/workflows/ci.yml`
- Create: `src/test/setup.ts`

- [ ] **Step 1: Write base package and config files**

Create `package.json`:

```json
{
  "name": "codex-reset-oracle",
  "version": "0.1.0",
  "private": false,
  "description": "Unofficial Codex reset forecast dashboard built from public signals.",
  "license": "MIT",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@next/env": "^16.0.0",
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.2.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "eslint": "^9.20.0",
    "eslint-config-next": "^16.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"]
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  }
});
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ]
});
```

Create `eslint.config.mjs`:

```js
import nextVitals from "eslint-config-next/core-web-vitals";

export default [...nextVitals];
```

- [ ] **Step 2: Add public safety files**

Create `.gitignore`:

```gitignore
node_modules/
.next/
out/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
.cache/
*.log
```

Create `.env.example`:

```dotenv
APIFY_TOKEN=
APIFY_ACTOR_ID=apidojo/twitter-scraper-lite
SNAPSHOT_REFRESH_MINUTES=45
```

Create `LICENSE` with the MIT License text and copyright line:

```text
MIT License

Copyright (c) 2026 Codex Reset Oracle contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Create `README.md`:

```md
# Codex Reset Oracle

Unofficial Codex reset forecast dashboard. It watches public signals from X/Twitter through Apify, OpenAI Status, and GitHub issues, then explains why the reset chance moved.

This project is not affiliated with OpenAI, X, or Apify. It does not provide official quota, usage, reset, or availability notices.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`
3. Add your Apify token as `APIFY_TOKEN`
4. Start locally: `npm run dev`
5. Open `http://127.0.0.1:3000`

## Data Sources

- X/Twitter posts are fetched through the Apify actor in `APIFY_ACTOR_ID`.
- OpenAI incidents are fetched from the public OpenAI Status JSON endpoint.
- GitHub issues are fetched from the public `openai/codex` repository.

## Forecast Score

The score is deterministic. Source quality, keyword strength, recency, and cross-source agreement all affect the output. Every forecast includes the top signals used to produce it.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```
```

- [ ] **Step 3: Add Vitest setup**

Create `src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Add CI**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: ["main", "master"]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 5: Install dependencies and verify scaffold**

Run:

```powershell
npm install
npm run typecheck
npm run lint
npm test
```

Expected: `typecheck`, `lint`, and `npm test` pass. Vitest should report no test files yet without treating that as a project failure.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json tsconfig.json next.config.mjs vitest.config.ts playwright.config.ts eslint.config.mjs .gitignore .env.example README.md LICENSE .github/workflows/ci.yml src/test/setup.ts
git commit -m "Scaffold public web app"
```

---

### Task 2: Domain Types, Defaults, And Scoring

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/defaults.ts`
- Create: `src/lib/scoring.ts`
- Create: `src/lib/scoring.test.ts`

- [ ] **Step 1: Write failing scoring tests**

Create `src/lib/scoring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreForecast } from "./scoring";
import type { Signal } from "./types";

const now = new Date("2026-06-06T12:00:00.000Z");

function signal(overrides: Partial<Signal>): Signal {
  return {
    id: "signal-1",
    source: "x",
    sourceLabel: "X/Twitter",
    sourceWeight: 1,
    author: "@thsottiaux",
    title: "Codex usage pressure",
    text: "Codex limit reset capacity update",
    url: "https://x.com/thsottiaux/status/1",
    publishedAt: "2026-06-06T11:45:00.000Z",
    matchedKeywords: ["codex", "limit", "reset", "capacity"],
    strength: 1,
    reason: "High-signal account mentioned reset and capacity.",
    ...overrides
  };
}

describe("scoreForecast", () => {
  it("returns no-data when every collector failed", () => {
    const forecast = scoreForecast([], now);
    expect(forecast.status).toBe("no-data");
    expect(forecast.chance).toBe(0);
    expect(forecast.summary).toMatch(/no fresh/i);
  });

  it("scores high when strong recent official signals agree", () => {
    const forecast = scoreForecast(
      [
        signal({ id: "x-team", sourceWeight: 1, source: "x" }),
        signal({
          id: "status",
          source: "openai-status",
          sourceLabel: "OpenAI Status",
          sourceWeight: 0.9,
          title: "Codex degraded performance",
          text: "Issue mitigated after capacity changes",
          matchedKeywords: ["codex", "capacity"],
          url: "https://status.openai.com"
        })
      ],
      now
    );
    expect(forecast.status).toBe("ok");
    expect(forecast.chance).toBeGreaterThanOrEqual(70);
    expect(forecast.topSignals).toHaveLength(2);
    expect(forecast.summary).toMatch(/strong/i);
  });

  it("scores low when only stale weak signals exist", () => {
    const forecast = scoreForecast(
      [
        signal({
          id: "old",
          sourceWeight: 0.25,
          publishedAt: "2026-06-03T12:00:00.000Z",
          matchedKeywords: ["codex"],
          strength: 0.2,
          reason: "Weak stale mention."
        })
      ],
      now
    );
    expect(forecast.status).toBe("ok");
    expect(forecast.chance).toBeLessThan(30);
    expect(forecast.window).toBe("No clear reset window");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- src/lib/scoring.test.ts
```

Expected: FAIL because `src/lib/scoring.ts` and `src/lib/types.ts` do not exist.

- [ ] **Step 3: Add shared types**

Create `src/lib/types.ts`:

```ts
export type SignalSource = "x" | "openai-status" | "github";

export type ForecastStatus = "ok" | "partial" | "stale" | "no-data";

export type CollectorStatus = {
  source: SignalSource;
  ok: boolean;
  message: string;
  fetchedAt?: string;
  stale?: boolean;
};

export type Signal = {
  id: string;
  source: SignalSource;
  sourceLabel: string;
  sourceWeight: number;
  author?: string;
  title: string;
  text: string;
  url: string;
  publishedAt: string;
  matchedKeywords: string[];
  strength: number;
  reason: string;
};

export type Forecast = {
  status: ForecastStatus;
  chance: number;
  window: string;
  summary: string;
  topSignals: Signal[];
  generatedAt: string;
};

export type Snapshot = {
  forecast: Forecast;
  signals: Signal[];
  collectors: CollectorStatus[];
};
```

- [ ] **Step 4: Add defaults**

Create `src/lib/defaults.ts`:

```ts
export const WATCHED_ACCOUNTS = [
  { handle: "thsottiaux", label: "Tibo", weight: 1 },
  { handle: "OpenAI", label: "OpenAI", weight: 1 },
  { handle: "OpenAIDevs", label: "OpenAI Developers", weight: 0.95 },
  { handle: "sama", label: "Sam Altman", weight: 0.6 },
  { handle: "gdb", label: "Greg Brockman", weight: 0.6 },
  { handle: "btibor91", label: "Tibor Blaho", weight: 0.35 }
] as const;

export const KEYWORD_WEIGHTS: Record<string, number> = {
  codex: 0.2,
  reset: 0.35,
  quota: 0.35,
  limit: 0.3,
  limits: 0.3,
  capacity: 0.3,
  usage: 0.25,
  degraded: 0.25,
  incident: 0.2,
  mitigated: 0.2,
  recovery: 0.25,
  queue: 0.15
};

export const REFRESH_MINUTES_DEFAULT = 45;
export const MAX_SIGNALS = 60;
```

- [ ] **Step 5: Implement scorer**

Create `src/lib/scoring.ts`:

```ts
import type { Forecast, Signal } from "./types";

function hoursOld(signal: Signal, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(signal.publishedAt).getTime()) / 3_600_000);
}

function recencyMultiplier(signal: Signal, now: Date): number {
  const age = hoursOld(signal, now);
  if (age <= 6) return 1;
  if (age <= 24) return 0.65;
  if (age <= 72) return 0.25;
  return 0.1;
}

function agreementBonus(signals: Signal[]): number {
  const sources = new Set(signals.map((signal) => signal.source));
  if (sources.size >= 3) return 18;
  if (sources.size === 2) return 10;
  return 0;
}

function predictionWindow(chance: number): string {
  if (chance >= 75) return "Likely within 6-18 hours";
  if (chance >= 55) return "Possible within 18-36 hours";
  if (chance >= 35) return "Watch for more signals";
  return "No clear reset window";
}

function summary(status: Forecast["status"], chance: number): string {
  if (status === "no-data") return "No fresh data is available, so no reset forecast is shown.";
  if (chance >= 75) return "Strong recent signals are clustering across trusted sources.";
  if (chance >= 55) return "Several useful signals exist, but confidence is still moderate.";
  if (chance >= 35) return "There are weak signals, but they do not agree strongly yet.";
  return "Current signals do not point to an imminent reset.";
}

export function scoreForecast(signals: Signal[], now = new Date()): Forecast {
  if (signals.length === 0) {
    return {
      status: "no-data",
      chance: 0,
      window: "No fresh data",
      summary: summary("no-data", 0),
      topSignals: [],
      generatedAt: now.toISOString()
    };
  }

  const ranked = signals
    .map((signal) => ({
      signal,
      score: signal.sourceWeight * signal.strength * recencyMultiplier(signal, now)
    }))
    .sort((a, b) => b.score - a.score);

  const raw = ranked.reduce((total, item) => total + item.score * 35, 0) + agreementBonus(signals);
  const chance = Math.max(1, Math.min(95, Math.round(raw)));

  return {
    status: "ok",
    chance,
    window: predictionWindow(chance),
    summary: summary("ok", chance),
    topSignals: ranked.slice(0, 5).map((item) => item.signal),
    generatedAt: now.toISOString()
  };
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
npm test -- src/lib/scoring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/types.ts src/lib/defaults.ts src/lib/scoring.ts src/lib/scoring.test.ts
git commit -m "Add forecast scoring model"
```

---

### Task 3: Normalization And Collector Tests

**Files:**
- Create: `src/lib/normalize.ts`
- Create: `src/lib/normalize.test.ts`
- Create: `src/test/fixtures/apify.ts`
- Create: `src/test/fixtures/status.ts`
- Create: `src/test/fixtures/github.ts`

- [ ] **Step 1: Write failing normalization tests**

Create `src/lib/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeApifyTweet, normalizeGithubIssue, normalizeStatusIncident } from "./normalize";
import { apifyTweetFixture } from "@/test/fixtures/apify";
import { githubIssueFixture } from "@/test/fixtures/github";
import { statusIncidentFixture } from "@/test/fixtures/status";

describe("normalize", () => {
  it("normalizes Apify tweet output into a signal", () => {
    const signal = normalizeApifyTweet(apifyTweetFixture);
    expect(signal?.source).toBe("x");
    expect(signal?.author).toBe("@thsottiaux");
    expect(signal?.matchedKeywords).toContain("reset");
    expect(signal?.sourceWeight).toBeGreaterThan(0.9);
  });

  it("normalizes Codex status incidents into a signal", () => {
    const signal = normalizeStatusIncident(statusIncidentFixture);
    expect(signal?.source).toBe("openai-status");
    expect(signal?.matchedKeywords).toContain("codex");
    expect(signal?.url).toContain("status.openai.com");
  });

  it("normalizes GitHub quota issues into a signal", () => {
    const signal = normalizeGithubIssue(githubIssueFixture);
    expect(signal?.source).toBe("github");
    expect(signal?.matchedKeywords).toContain("quota");
    expect(signal?.reason).toMatch(/github/i);
  });

  it("returns null for unrelated records", () => {
    expect(
      normalizeGithubIssue({
        ...githubIssueFixture,
        title: "Documentation typo",
        body: "Small spelling issue in docs."
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Add fixture payloads**

Create `src/test/fixtures/apify.ts`:

```ts
export const apifyTweetFixture = {
  id: "1800000000000000001",
  url: "https://x.com/thsottiaux/status/1800000000000000001",
  text: "Watching Codex usage pressure. Reset and capacity work is moving.",
  createdAt: "2026-06-06T11:45:00.000Z",
  author: {
    userName: "thsottiaux",
    name: "Tibo"
  }
};
```

Create `src/test/fixtures/status.ts`:

```ts
export const statusIncidentFixture = {
  id: "incident-1",
  name: "Codex degraded performance",
  shortlink: "https://stspg.io/example",
  created_at: "2026-06-06T10:30:00.000Z",
  updated_at: "2026-06-06T11:00:00.000Z",
  status: "monitoring",
  impact: "minor",
  incident_updates: [
    {
      body: "We are monitoring Codex capacity after a usage spike.",
      created_at: "2026-06-06T11:00:00.000Z"
    }
  ]
};
```

Create `src/test/fixtures/github.ts`:

```ts
export const githubIssueFixture = {
  id: 20395,
  number: 20395,
  html_url: "https://github.com/openai/codex/issues/20395",
  title: "Quota did not reset after limit hit",
  body: "Codex usage quota still says limit reached after waiting.",
  created_at: "2026-06-06T09:00:00.000Z",
  updated_at: "2026-06-06T11:20:00.000Z",
  user: { login: "example-user" },
  pull_request: undefined
};
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```powershell
npm test -- src/lib/normalize.test.ts
```

Expected: FAIL because `src/lib/normalize.ts` does not exist.

- [ ] **Step 4: Implement normalization**

Create `src/lib/normalize.ts`:

```ts
import { KEYWORD_WEIGHTS, WATCHED_ACCOUNTS } from "./defaults";
import type { Signal } from "./types";

type RawApifyTweet = {
  id?: string;
  url?: string;
  text?: string;
  fullText?: string;
  createdAt?: string;
  author?: { userName?: string; username?: string; name?: string };
  username?: string;
};

type RawStatusIncident = {
  id: string;
  name: string;
  shortlink?: string;
  created_at: string;
  updated_at?: string;
  status?: string;
  impact?: string;
  incident_updates?: Array<{ body?: string; created_at?: string }>;
};

type RawGithubIssue = {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  created_at: string;
  updated_at: string;
  user?: { login?: string };
  pull_request?: unknown;
};

function lowerText(value: string): string {
  return value.toLowerCase();
}

function matchKeywords(text: string): string[] {
  const lower = lowerText(text);
  return Object.keys(KEYWORD_WEIGHTS).filter((keyword) => lower.includes(keyword));
}

function strengthFor(keywords: string[]): number {
  const score = keywords.reduce((total, keyword) => total + (KEYWORD_WEIGHTS[keyword] ?? 0), 0);
  return Math.max(0.1, Math.min(1, score));
}

function accountWeight(handle?: string): number {
  const clean = handle?.replace(/^@/, "").toLowerCase();
  return WATCHED_ACCOUNTS.find((account) => account.handle.toLowerCase() === clean)?.weight ?? 0.4;
}

function stableId(prefix: string, value: string | number): string {
  return `${prefix}:${value}`;
}

export function normalizeApifyTweet(raw: RawApifyTweet): Signal | null {
  const text = raw.text ?? raw.fullText ?? "";
  const keywords = matchKeywords(text);
  if (!keywords.includes("codex") || keywords.length < 2) return null;

  const handle = raw.author?.userName ?? raw.author?.username ?? raw.username ?? "unknown";
  return {
    id: stableId("x", raw.id ?? raw.url ?? `${handle}:${raw.createdAt}`),
    source: "x",
    sourceLabel: "X/Twitter",
    sourceWeight: accountWeight(handle),
    author: `@${handle.replace(/^@/, "")}`,
    title: text.slice(0, 96),
    text,
    url: raw.url ?? `https://x.com/${handle}`,
    publishedAt: raw.createdAt ?? new Date().toISOString(),
    matchedKeywords: keywords,
    strength: strengthFor(keywords),
    reason: `${handle} mentioned ${keywords.join(", ")}.`
  };
}

export function normalizeStatusIncident(raw: RawStatusIncident): Signal | null {
  const updateText = raw.incident_updates?.map((update) => update.body ?? "").join(" ") ?? "";
  const text = `${raw.name} ${raw.status ?? ""} ${raw.impact ?? ""} ${updateText}`;
  const keywords = matchKeywords(text);
  if (!keywords.includes("codex")) return null;

  return {
    id: stableId("status", raw.id),
    source: "openai-status",
    sourceLabel: "OpenAI Status",
    sourceWeight: 0.9,
    title: raw.name,
    text,
    url: raw.shortlink ?? "https://status.openai.com",
    publishedAt: raw.updated_at ?? raw.created_at,
    matchedKeywords: keywords,
    strength: strengthFor(keywords),
    reason: `OpenAI Status incident includes ${keywords.join(", ")}.`
  };
}

export function normalizeGithubIssue(raw: RawGithubIssue): Signal | null {
  if (raw.pull_request) return null;
  const text = `${raw.title} ${raw.body ?? ""}`;
  const keywords = matchKeywords(text);
  if (!keywords.includes("codex") || keywords.length < 2) return null;

  return {
    id: stableId("github", raw.id),
    source: "github",
    sourceLabel: "GitHub Issues",
    sourceWeight: 0.45,
    author: raw.user?.login,
    title: `#${raw.number} ${raw.title}`,
    text,
    url: raw.html_url,
    publishedAt: raw.updated_at,
    matchedKeywords: keywords,
    strength: strengthFor(keywords),
    reason: `GitHub issue mentions ${keywords.join(", ")}.`
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- src/lib/normalize.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/normalize.ts src/lib/normalize.test.ts src/test/fixtures/apify.ts src/test/fixtures/status.ts src/test/fixtures/github.ts
git commit -m "Normalize forecast signals"
```

---

### Task 4: Source Collectors

**Files:**
- Create: `src/lib/collectors/apify.ts`
- Create: `src/lib/collectors/openai-status.ts`
- Create: `src/lib/collectors/github.ts`
- Create: `src/lib/collectors/collectors.test.ts`

- [ ] **Step 1: Write failing collector tests**

Create `src/lib/collectors/collectors.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectApifySignals } from "./apify";
import { collectGithubSignals } from "./github";
import { collectOpenAIStatusSignals } from "./openai-status";
import { apifyTweetFixture } from "@/test/fixtures/apify";
import { githubIssueFixture } from "@/test/fixtures/github";
import { statusIncidentFixture } from "@/test/fixtures/status";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockFetchJson(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload
    }))
  );
}

describe("collectors", () => {
  it("skips Apify when token is missing", async () => {
    const result = await collectApifySignals({ token: "", actorId: "apidojo/twitter-scraper-lite" });
    expect(result.status.ok).toBe(false);
    expect(result.signals).toEqual([]);
    expect(result.status.message).toMatch(/APIFY_TOKEN/);
  });

  it("collects Apify tweet signals", async () => {
    mockFetchJson([apifyTweetFixture]);
    const result = await collectApifySignals({ token: "token", actorId: "actor/id" });
    expect(result.status.ok).toBe(true);
    expect(result.signals[0].source).toBe("x");
  });

  it("collects OpenAI Status signals", async () => {
    mockFetchJson({ incidents: [statusIncidentFixture] });
    const result = await collectOpenAIStatusSignals();
    expect(result.status.ok).toBe(true);
    expect(result.signals[0].source).toBe("openai-status");
  });

  it("collects GitHub issue signals", async () => {
    mockFetchJson([githubIssueFixture]);
    const result = await collectGithubSignals();
    expect(result.status.ok).toBe(true);
    expect(result.signals[0].source).toBe("github");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- src/lib/collectors/collectors.test.ts
```

Expected: FAIL because collector files do not exist.

- [ ] **Step 3: Implement Apify collector**

Create `src/lib/collectors/apify.ts`:

```ts
import { WATCHED_ACCOUNTS } from "../defaults";
import { normalizeApifyTweet } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

type ApifyOptions = {
  token?: string;
  actorId?: string;
};

function apifyUrl(actorId: string): string {
  const encodedActor = actorId.replace("/", "~");
  return `https://api.apify.com/v2/acts/${encodedActor}/run-sync-get-dataset-items?clean=true&format=json&maxTotalChargeUsd=1`;
}

function apifyInput() {
  return {
    twitterHandles: WATCHED_ACCOUNTS.map((account) => account.handle),
    searchTerms: WATCHED_ACCOUNTS.map((account) => `from:${account.handle} codex OR reset OR quota OR limit OR capacity`),
    sort: "Latest",
    maxItems: 80,
    includeSearchTerms: true
  };
}

export async function collectApifySignals(options: ApifyOptions): Promise<CollectorResult> {
  if (!options.token) {
    return {
      status: { source: "x", ok: false, message: "APIFY_TOKEN is missing." },
      signals: []
    };
  }

  const actorId = options.actorId || "apidojo/twitter-scraper-lite";
  const response = await fetch(apifyUrl(actorId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`
    },
    body: JSON.stringify(apifyInput())
  });

  if (!response.ok) {
    return {
      status: { source: "x", ok: false, message: `Apify returned HTTP ${response.status}.` },
      signals: []
    };
  }

  const rows = (await response.json()) as unknown[];
  const signals = rows.map((row) => normalizeApifyTweet(row as never)).filter((signal): signal is Signal => Boolean(signal));

  return {
    status: { source: "x", ok: true, message: `Fetched ${signals.length} X signals.`, fetchedAt: new Date().toISOString() },
    signals
  };
}
```

- [ ] **Step 4: Implement OpenAI Status collector**

Create `src/lib/collectors/openai-status.ts`:

```ts
import { normalizeStatusIncident } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

type StatusPayload = {
  incidents?: unknown[];
};

export async function collectOpenAIStatusSignals(): Promise<{ status: CollectorStatus; signals: Signal[] }> {
  const response = await fetch("https://status.openai.com/api/v2/incidents.json", {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    return {
      status: { source: "openai-status", ok: false, message: `OpenAI Status returned HTTP ${response.status}.` },
      signals: []
    };
  }

  const payload = (await response.json()) as StatusPayload;
  const signals = (payload.incidents ?? [])
    .map((incident) => normalizeStatusIncident(incident as never))
    .filter((signal): signal is Signal => Boolean(signal));

  return {
    status: {
      source: "openai-status",
      ok: true,
      message: `Fetched ${signals.length} OpenAI Status signals.`,
      fetchedAt: new Date().toISOString()
    },
    signals
  };
}
```

- [ ] **Step 5: Implement GitHub collector**

Create `src/lib/collectors/github.ts`:

```ts
import { normalizeGithubIssue } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

export async function collectGithubSignals(): Promise<{ status: CollectorStatus; signals: Signal[] }> {
  const response = await fetch("https://api.github.com/repos/openai/codex/issues?state=all&sort=updated&direction=desc&per_page=50", {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    return {
      status: { source: "github", ok: false, message: `GitHub returned HTTP ${response.status}.` },
      signals: []
    };
  }

  const rows = (await response.json()) as unknown[];
  const signals = rows.map((row) => normalizeGithubIssue(row as never)).filter((signal): signal is Signal => Boolean(signal));

  return {
    status: { source: "github", ok: true, message: `Fetched ${signals.length} GitHub signals.`, fetchedAt: new Date().toISOString() },
    signals
  };
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
npm test -- src/lib/collectors/collectors.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/collectors/apify.ts src/lib/collectors/openai-status.ts src/lib/collectors/github.ts src/lib/collectors/collectors.test.ts
git commit -m "Add signal collectors"
```

---

### Task 5: Snapshot Orchestration And API Route

**Files:**
- Create: `src/lib/snapshot.ts`
- Create: `src/lib/snapshot.test.ts`
- Create: `src/app/api/snapshot/route.ts`

- [ ] **Step 1: Write failing snapshot tests**

Create `src/lib/snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./snapshot";
import type { CollectorStatus, Signal } from "./types";

const statusOk: CollectorStatus = { source: "github", ok: true, message: "ok", fetchedAt: "2026-06-06T12:00:00.000Z" };
const statusFail: CollectorStatus = { source: "x", ok: false, message: "missing token" };

const signal: Signal = {
  id: "github:1",
  source: "github",
  sourceLabel: "GitHub Issues",
  sourceWeight: 0.45,
  title: "Codex quota reset",
  text: "Codex quota reset limit",
  url: "https://github.com/openai/codex/issues/1",
  publishedAt: "2026-06-06T11:30:00.000Z",
  matchedKeywords: ["codex", "quota", "reset", "limit"],
  strength: 1,
  reason: "GitHub issue mentions quota."
};

describe("buildSnapshot", () => {
  it("marks partial when one collector fails but data exists", () => {
    const snapshot = buildSnapshot([
      { status: statusFail, signals: [] },
      { status: statusOk, signals: [signal] }
    ], new Date("2026-06-06T12:00:00.000Z"));
    expect(snapshot.forecast.status).toBe("partial");
    expect(snapshot.signals).toHaveLength(1);
  });

  it("deduplicates signals by id", () => {
    const snapshot = buildSnapshot([
      { status: statusOk, signals: [signal, signal] }
    ], new Date("2026-06-06T12:00:00.000Z"));
    expect(snapshot.signals).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- src/lib/snapshot.test.ts
```

Expected: FAIL because `src/lib/snapshot.ts` does not exist.

- [ ] **Step 3: Implement snapshot orchestration**

Create `src/lib/snapshot.ts`:

```ts
import { collectApifySignals } from "./collectors/apify";
import { collectGithubSignals } from "./collectors/github";
import { collectOpenAIStatusSignals } from "./collectors/openai-status";
import { REFRESH_MINUTES_DEFAULT } from "./defaults";
import { scoreForecast } from "./scoring";
import type { CollectorStatus, Forecast, Signal, Snapshot } from "./types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

function dedupeSignals(signals: Signal[]): Signal[] {
  return Array.from(new Map(signals.map((signal) => [signal.id, signal])).values());
}

function applyCollectorStatus(forecast: Forecast, collectors: CollectorStatus[]): Forecast {
  const hasFailure = collectors.some((collector) => !collector.ok);
  if (forecast.status === "ok" && hasFailure) return { ...forecast, status: "partial" };
  return forecast;
}

export function buildSnapshot(results: CollectorResult[], now = new Date()): Snapshot {
  const collectors = results.map((result) => result.status);
  const signals = dedupeSignals(results.flatMap((result) => result.signals));
  const forecast = applyCollectorStatus(scoreForecast(signals, now), collectors);
  return { forecast, signals, collectors };
}

export function refreshMinutes(): number {
  const raw = Number(process.env.SNAPSHOT_REFRESH_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : REFRESH_MINUTES_DEFAULT;
}

export async function collectSnapshot(): Promise<Snapshot> {
  const results = await Promise.all([
    collectApifySignals({ token: process.env.APIFY_TOKEN, actorId: process.env.APIFY_ACTOR_ID }),
    collectOpenAIStatusSignals(),
    collectGithubSignals()
  ]);

  return buildSnapshot(results);
}
```

- [ ] **Step 4: Add API route**

Create `src/app/api/snapshot/route.ts`:

```ts
import { NextResponse } from "next/server";
import { collectSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await collectSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown snapshot error";
    return NextResponse.json(
      {
        forecast: {
          status: "no-data",
          chance: 0,
          window: "No fresh data",
          summary: message,
          topSignals: [],
          generatedAt: new Date().toISOString()
        },
        signals: [],
        collectors: []
      },
      { status: 200 }
    );
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- src/lib/snapshot.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/snapshot.ts src/lib/snapshot.test.ts src/app/api/snapshot/route.ts
git commit -m "Add forecast snapshot API"
```

---

### Task 6: Dashboard UI

**Files:**
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/components/ForecastDashboard.tsx`
- Create: `src/components/ForecastDashboard.test.tsx`

- [ ] **Step 1: Write failing component test**

Create `src/components/ForecastDashboard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ForecastDashboard } from "./ForecastDashboard";
import type { Snapshot } from "@/lib/types";

const snapshot: Snapshot = {
  forecast: {
    status: "ok",
    chance: 72,
    window: "Possible within 18-36 hours",
    summary: "Several useful signals exist, but confidence is still moderate.",
    generatedAt: "2026-06-06T12:00:00.000Z",
    topSignals: [
      {
        id: "x:1",
        source: "x",
        sourceLabel: "X/Twitter",
        sourceWeight: 1,
        author: "@thsottiaux",
        title: "Codex reset capacity",
        text: "Codex reset capacity update",
        url: "https://x.com/thsottiaux/status/1",
        publishedAt: "2026-06-06T11:45:00.000Z",
        matchedKeywords: ["codex", "reset", "capacity"],
        strength: 1,
        reason: "Tibo mentioned reset and capacity."
      }
    ]
  },
  signals: [],
  collectors: [
    { source: "x", ok: true, message: "Fetched 1 X signals.", fetchedAt: "2026-06-06T12:00:00.000Z" }
  ]
};

describe("ForecastDashboard", () => {
  it("renders forecast, window, and signal reasons", () => {
    render(<ForecastDashboard initialSnapshot={snapshot} />);
    expect(screen.getByText("Codex Reset Chance")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText("Possible within 18-36 hours")).toBeInTheDocument();
    expect(screen.getByText(/Tibo mentioned/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- src/components/ForecastDashboard.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Add app shell**

Create `src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Codex Reset Oracle",
  description: "Unofficial Codex reset forecast dashboard"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `src/app/page.tsx`:

```tsx
import { ForecastDashboard } from "@/components/ForecastDashboard";
import type { Snapshot } from "@/lib/types";

const emptySnapshot: Snapshot = {
  forecast: {
    status: "no-data",
    chance: 0,
    window: "No fresh data",
    summary: "Connect APIFY_TOKEN or refresh the dashboard to load public signals.",
    topSignals: [],
    generatedAt: new Date().toISOString()
  },
  signals: [],
  collectors: []
};

export default function Home() {
  return <ForecastDashboard initialSnapshot={emptySnapshot} />;
}
```

- [ ] **Step 4: Add dashboard component**

Create `src/components/ForecastDashboard.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { Snapshot } from "@/lib/types";

export function ForecastDashboard({ initialSnapshot }: { initialSnapshot: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      const nextSnapshot = (await response.json()) as Snapshot;
      setSnapshot(nextSnapshot);
    } finally {
      setLoading(false);
    }
  }

  const statusText = useMemo(() => {
    if (snapshot.forecast.status === "no-data") return "No fresh data";
    if (snapshot.forecast.status === "partial") return "Partial data";
    if (snapshot.forecast.status === "stale") return "Stale data";
    return "Live forecast";
  }, [snapshot.forecast.status]);

  return (
    <main className="shell">
      <section className="forecast">
        <div>
          <p className="eyebrow">{statusText}</p>
          <h1>Codex Reset Chance</h1>
        </div>
        <div className="score" aria-label={`Codex reset chance ${snapshot.forecast.chance}%`}>
          {snapshot.forecast.chance}%
        </div>
        <p className="window">{snapshot.forecast.window}</p>
        <p className="summary">{snapshot.forecast.summary}</p>
        <button className="refresh" type="button" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      <section className="grid" aria-label="Forecast details">
        <div className="panel">
          <h2>Top Signals</h2>
          <div className="list">
            {snapshot.forecast.topSignals.length === 0 ? (
              <p className="muted">No matching public signals have been found yet.</p>
            ) : (
              snapshot.forecast.topSignals.map((signal) => (
                <a className="signal" href={signal.url} key={signal.id} target="_blank" rel="noreferrer">
                  <span className="source">{signal.sourceLabel}</span>
                  <strong>{signal.title}</strong>
                  <span>{signal.reason}</span>
                  <small>{signal.matchedKeywords.join(", ")}</small>
                </a>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <h2>Collectors</h2>
          <div className="list">
            {snapshot.collectors.length === 0 ? (
              <p className="muted">Collector results will appear after the first refresh.</p>
            ) : (
              snapshot.collectors.map((collector) => (
                <div className="collector" key={collector.source}>
                  <span className={collector.ok ? "dot ok" : "dot fail"} />
                  <span>{collector.source}</span>
                  <small>{collector.message}</small>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Add responsive CSS**

Create `src/app/globals.css`:

```css
:root {
  color-scheme: light;
  --bg: #f7f8f3;
  --ink: #17201d;
  --muted: #66736d;
  --line: #d9dfd4;
  --panel: #ffffff;
  --accent: #0f7b6c;
  --warn: #a45f00;
  --bad: #b42318;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: Arial, Helvetica, sans-serif;
}

.shell {
  width: min(1120px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0;
}

.forecast {
  display: grid;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.eyebrow,
.source,
small,
.muted {
  color: var(--muted);
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: clamp(32px, 6vw, 64px);
  line-height: 1;
}

h2 {
  font-size: 18px;
}

.score {
  font-size: clamp(52px, 12vw, 132px);
  font-weight: 800;
  line-height: 0.95;
  color: var(--accent);
}

.window {
  font-size: 22px;
  font-weight: 700;
}

.summary {
  max-width: 720px;
  color: var(--muted);
  line-height: 1.5;
}

.refresh {
  width: fit-content;
  min-height: 40px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: white;
  padding: 0 16px;
  font-weight: 700;
  cursor: pointer;
}

.refresh:disabled {
  cursor: wait;
  opacity: 0.7;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  gap: 16px;
  margin-top: 16px;
}

.panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 18px;
}

.list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.signal,
.collector {
  display: grid;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px;
  color: inherit;
  text-decoration: none;
}

.collector {
  grid-template-columns: auto 1fr;
  align-items: center;
}

.collector small {
  grid-column: 2;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.dot.ok {
  background: var(--accent);
}

.dot.fail {
  background: var(--bad);
}

@media (max-width: 760px) {
  .shell {
    width: min(100% - 20px, 1120px);
    padding: 16px 0;
  }

  .grid {
    grid-template-columns: 1fr;
  }

  .forecast {
    padding: 18px;
  }
}
```

- [ ] **Step 6: Run component tests**

Run:

```powershell
npm test -- src/components/ForecastDashboard.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/app/layout.tsx src/app/page.tsx src/app/globals.css src/components/ForecastDashboard.tsx src/components/ForecastDashboard.test.tsx
git commit -m "Add forecast dashboard"
```

---

### Task 7: Browser Verification And Release Readiness

**Files:**
- Create: `tests/dashboard.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: Add Playwright smoke test**

Create `tests/dashboard.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("dashboard renders on desktop and mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Codex Reset Chance" })).toBeVisible();
  await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();
  await expect(page.getByText(/not affiliated with OpenAI/i).or(page.getByText(/No fresh data/i))).toBeVisible();
});
```

- [ ] **Step 2: Add visible public disclaimer to dashboard**

Modify `src/components/ForecastDashboard.tsx` so the bottom of `<main>` includes:

```tsx
<p className="disclaimer">
  Unofficial project. Not affiliated with OpenAI, X, or Apify. Forecasts are estimates from public signals, not official notices.
</p>
```

Modify `src/app/globals.css`:

```css
.disclaimer {
  margin-top: 16px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
```

- [ ] **Step 3: Run all local checks**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Expected: all commands pass. If Playwright browsers are missing, run `npx playwright install chromium` once and rerun `npm run test:e2e`.

- [ ] **Step 4: Inspect git status for secrets and cache files**

Run:

```powershell
git status --short
Get-ChildItem -Force
```

Expected: `.env` and `.cache` are not staged. Only source, docs, tests, lockfiles, and config files are staged.

- [ ] **Step 5: Commit**

```powershell
git add tests/dashboard.spec.ts src/components/ForecastDashboard.tsx src/app/globals.css README.md
git commit -m "Prepare dashboard for public release"
```

---

### Task 8: GitHub Publishing Prep

**Files:**
- Modify only if checks reveal gaps: `README.md`, `.env.example`, `.gitignore`

- [ ] **Step 1: Confirm repository metadata**

Run:

```powershell
git log --oneline --max-count=6
git status --short
```

Expected: clean working tree after the final commit.

- [ ] **Step 2: Verify GitHub CLI availability before publishing**

Run:

```powershell
gh --version
gh auth status
```

Expected: `gh --version` prints a version and `gh auth status` shows an authenticated GitHub account. If auth is missing, stop and ask the user to authenticate GitHub in the desktop app or CLI.

- [ ] **Step 3: Create public GitHub repository only after user approval**

Use the repository name `codex-reset-oracle` unless the user requests another name.

```powershell
gh repo create codex-reset-oracle --public --source . --remote origin --description "Unofficial Codex reset forecast dashboard" --push
```

Expected: GitHub creates a public repository, sets `origin`, and pushes the current branch.

- [ ] **Step 4: Confirm public URL**

Run:

```powershell
git remote get-url origin
gh repo view --web --json nameWithOwner,url
```

Expected: command output includes the public GitHub URL.

---

## Self-Review Checklist

- Spec coverage: Apify, OpenAI Status, GitHub issues, deterministic scoring, dashboard, missing-token state, public GitHub safety, README, license, CI, and disclaimer are covered.
- Source boundaries: no official X API is required; Apify actor is configurable through `APIFY_ACTOR_ID`.
- Secret safety: `.env`, `.env.*`, and `.cache/` are ignored while `.env.example` is committed.
- Testing coverage: scorer, normalization, collectors, snapshot orchestration, component render, build, and browser smoke checks are covered.
- Release gate: public repository creation is separated into a final approval step.
