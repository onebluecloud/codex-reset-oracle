# Codex Reset Oracle Design

## Goal

Build a small automated "Codex reset forecast" web tool that watches public signals and estimates whether a Codex usage reset or quota relief event is likely soon. The tool is intentionally framed as a playful prediction dashboard, not an official OpenAI notice or a decision system.

The first version prioritizes automation and explainability over complex modeling. It should answer three questions:

1. What is the current reset chance?
2. What recent signals pushed the score up or down?
3. Which sources should the user trust most?

## First-Version Scope

The first version will collect signals from:

- X/Twitter through Apify, using the user's Apify token.
- OpenAI Status, using public status JSON.
- GitHub issue search for `openai/codex` limit, quota, reset, usage, and capacity complaints.

Community search is not required for the first version. It can be added only if a stable source is available without fragile scraping.

The first version will not use the official X API, will not require the user to edit code or scripts, and will not post anything automatically. It will also not implement autonomous account discovery yet; that belongs in a later version after the base scorer is working.

## Watched Accounts

The default X account pool will be weighted by likely signal quality:

- High weight: `@thsottiaux`, `@OpenAI`, `@OpenAIDevs`.
- Medium weight: `@sama`, `@gdb`.
- Low weight: `@btibor91`.

The reason for this split is that direct Codex team and official developer sources are more likely to carry product or capacity signals, while broader OpenAI leaders and outside researchers are useful but noisier.

## Architecture

The app will be a local web app with three clear layers:

1. Data collectors
   - `xCollector`: runs Apify queries for the watched accounts and relevant Codex keywords.
   - `statusCollector`: fetches OpenAI Status incidents and components.
   - `githubCollector`: searches recent `openai/codex` issues for limit and quota language.

2. Signal engine
   - Normalizes every item into a common signal shape: source, author, timestamp, text, matched keywords, source weight, sentiment, and URL.
   - Deduplicates repeated items.
   - Scores signals based on source quality, keyword strength, recency, and whether multiple sources agree.

3. Dashboard
   - Shows a single headline score such as `Codex Reset Chance: 72%`.
   - Shows a prediction window such as `Likely within 6-18 hours`.
   - Shows the top signals with source links and plain-language reasons.
   - Shows collector status so the user can tell whether Apify, Status, or GitHub failed.

## Scoring Model

The first scorer will be deterministic and explainable:

- Strong positive signals: official or Codex-team mentions of reset, quota, capacity, limits, usage pressure, launch windows, or incident recovery.
- Medium positive signals: many GitHub/community reports about the same quota or limit issue in a short period.
- Negative or cooling signals: no recent relevant activity, recent reset already happened, or status has no Codex-related issue.
- Recency decay: signals lose strength as they get older.
- Agreement bonus: independent sources saying similar things in the same time window increase confidence.

The output should include both the score and the reason. A score without explanation is considered a failed result.

## Data Flow

1. A scheduled refresh runs every 30-60 minutes.
2. Each collector fetches recent items from its source.
3. The signal engine normalizes and scores items.
4. The app stores the latest snapshot locally.
5. The dashboard reads the latest snapshot and renders the forecast.

Manual refresh should also be available from the dashboard.

## Configuration

The user should only need to provide:

- `APIFY_TOKEN`

Configuration should live in an `.env` file that is not committed. The app should include a visible setup state if the token is missing, with human-readable instructions inside the dashboard.

The watched account list and keywords should ship with sensible defaults. They can be edited later through a config file or simple settings screen, but the first version should work without the user choosing accounts.

## Public GitHub Release

The project should be safe to publish as a public GitHub repository after the first working version:

- Include a clear `README.md` with setup, Apify token instructions, local run commands, and a short explanation of how the forecast score works.
- Include `.env.example` but never commit `.env`, tokens, local cache files, or fetched raw datasets.
- Include a license suitable for public reuse. The default should be MIT unless the user asks for a more restrictive license.
- Include a disclaimer that the project is unofficial, is not affiliated with OpenAI, and does not provide official Codex quota or reset notices.
- Include GitHub Actions for install, tests, typecheck, lint, and build.
- Keep any default watched accounts and keywords in source-controlled config so contributors can review or suggest changes.
- Avoid using OpenAI, Codex, X, or Apify logos in a way that implies endorsement.

## Error Handling

The app should degrade gracefully:

- If Apify fails, keep showing OpenAI Status and GitHub signals.
- If OpenAI Status fails, keep showing X and GitHub signals.
- If GitHub rate limits the app, show the last successful GitHub snapshot and mark it stale.
- If all collectors fail, show a clear "no fresh data" state instead of a misleading probability.

The dashboard must distinguish "low reset chance" from "could not fetch data".

## Testing

Implementation should include focused tests for:

- Signal normalization from sample Apify, OpenAI Status, and GitHub responses.
- Keyword matching and source weighting.
- Score calculation for high, medium, low, and no-data scenarios.
- Staleness and collector failure behavior.

Browser verification should check that the dashboard renders a non-empty forecast, handles missing `APIFY_TOKEN`, and shows source cards without layout overlap.

## Later Versions

Later versions can add:

- Automatic account discovery based on who Codex team members reply to or who historically predicts OpenAI changes accurately.
- Alerting through desktop notification, email, Telegram, or Discord.
- A historical accuracy chart comparing predictions with observed reset events.
- RSSHub as a fallback source if the user provides a working Twitter auth token.

These are intentionally excluded from the first version to keep the build small and reliable.

## Approval State

The user approved the automated multi-source direction with Apify as the X/Twitter data source on June 6, 2026.
