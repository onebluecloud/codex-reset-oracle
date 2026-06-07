# Codex Reset Oracle

Unofficial Codex reset forecast dashboard built from public signals. It watches Codex Reset Radar, OpenAI Status, GitHub issues, and optional X/Twitter data through Apify, then explains why the reset chance moved.

## Setup

1. Install Node.js 22.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set `APIFY_TOKEN` if X/Twitter collection is needed. The Codex Reset Radar fallback, OpenAI Status, and GitHub sources work without an API token.
4. Start the local app:

   ```bash
   npm run dev
   ```

5. Open `http://127.0.0.1:3000`.

## Data Sources

The app is designed to use public signals only:

- Public X posts and conversations collected through the Apify actor configured by `APIFY_ACTOR_ID`.
- Public Codex Reset Radar `current.json` forecast data.
- Public OpenAI Status incident data.
- Public GitHub issues and discussions related to Codex reset behavior.
- Publicly visible timestamps, user reports, and observed reset-related language.
- Local derived snapshots produced from the configured refresh cadence.

No private OpenAI account data, private X data, or non-public quota telemetry should be used.

If `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is set, the Next.js dev/build/start scripts automatically enable Node's environment proxy support when the local Node runtime supports it.

## Forecast Score

The forecast score is an estimated reset likelihood derived from public-signal freshness, volume, source diversity, and reset-language strength. It is a heuristic dashboard score, not a guaranteed prediction or authoritative quota value.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

End-to-end tests can be run with:

```bash
npm run test:e2e
```

## Disclaimer

This project is not affiliated with OpenAI, X, or Apify and does not provide official quota/reset notices. Treat all forecasts as unofficial estimates from public signals.
