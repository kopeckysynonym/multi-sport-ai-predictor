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


## Upcoming matches workflow

The frontend no longer asks the user to manually combine two teams. It loads real upcoming fixtures from:

- **Czech football:** API-Football fixtures for the Czech top league.
- **FIFA / UEFA:** The Odds API event feeds for supported FIFA and UEFA competitions.
- **NBA / NHL:** The Odds API event feeds.

Endpoint:

```
GET /api/upcoming?sport=cz_football
GET /api/upcoming?sport=fifa
GET /api/upcoming?sport=nba
GET /api/upcoming?sport=nhl
```

The selected event is sent to `POST /api/predict` as `fixture`, so the prediction, kickoff time and odds refer to the same real event.

For Czech football, `API_FOOTBALL_CZ_LEAGUE_ID` can optionally override the default league ID (`345`).
