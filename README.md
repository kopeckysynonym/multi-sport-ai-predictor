# Multi-Sport AI Predictor

Netlify-native web app for football, NBA and NHL predictions using Netlify Functions, API-Football and The Odds API.

## Architecture

- Static frontend in `public/`
- Netlify Functions in `netlify/functions/`
- Secrets via Netlify environment variables
- No Flask/Python runtime required

## Environment variables

Set these in Netlify:

```text
API_FOOTBALL_KEY=...
ODDS_API_KEY=...
LIVE_DATA_ENABLED=true
API_TIMEOUT_MS=10000
ODDS_REGIONS=eu
ODDS_SPORT_NBA=basketball_nba
ODDS_SPORT_NHL=icehockey_nhl
ODDS_SPORT_CZ_FOOTBALL=
ODDS_SPORT_FIFA=
```

## Main endpoints

- `/api/health`
- `/api/teams`
- `/api/team-mapping`
- `/api/odds`
- `/api/predict`

## Tests

```bash
npm test
```

The `/api/odds` test suite covers successful event matching, missing events, empty markets, timeout, HTTP 401/429 and invalid JSON.

## Deploy

Connect this repository to Netlify. `netlify.toml` defines the publish directory, functions directory and API redirects.
