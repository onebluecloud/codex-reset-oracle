# Codex Reset Oracle

Unofficial Codex reset forecast dashboard built from public signals. It watches public signals from X/Twitter through Apify, OpenAI Status, and GitHub issues, then explains why the reset chance moved.

## Setup

1. Install Node.js 22.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set `APIFY_TOKEN` if live snapshot refreshes are needed.
4. Start the local app:

   ```bash
   npm run dev
   ```

5. Open `http://127.0.0.1:3000`.

## Data Sources

The app is designed to use public signals only:

- Public X posts and conversations collected through the Apify actor configured by `APIFY_ACTOR_ID`.
- Public OpenAI Status incident data.
- Public GitHub issues and discussions related to Codex reset behavior.
- Publicly visible timestamps, user reports, and observed reset-related language.
- Local derived snapshots produced from the configured refresh cadence.

No private OpenAI account data, private X data, or non-public quota telemetry should be used.

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
