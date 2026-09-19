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


## NBA live team metrics

NBA predictions now load the latest 10 completed games for both teams from ESPN's public NBA schedule and game-summary endpoints.

For each team the backend calculates:

- last-10 W-L record
- points scored per game
- points allowed per game
- home form and road form
- estimated possessions / pace
- offensive rating = 100 × points / estimated possessions
- defensive rating = 100 × opponent points / opponent estimated possessions

Estimated possessions use the standard box-score approximation:

```
FGA + 0.44 * FTA - OREB + TOV
```

The NBA prediction model combines both teams' last-10 pace and offensive/defensive ratings, then blends in the home team's home form and the away team's road form. There is no league-average prediction fallback: if enough real game/boxscore data cannot be loaded, the prediction endpoint returns an explicit data error instead of generating a betting recommendation.


## Current-season-only NBA rule

For NBA predictions, historical games are restricted to the season containing the selected fixture. The backend queries only that season's regular-season and playoff schedules and never fills the sample with games from the previous season.

- Uses up to the latest 10 completed games from the current season.
- Requires at least 3 completed current-season games to produce the NBA model.
- If fewer than 10 current-season games are available, the prediction remains marked as limited reliability and no betting recommendation is issued.
- Previous-season games are excluded completely once the selected fixture belongs to the new season.


## Current-season-only NHL rule

NHL predictions now follow the same season-safety rules as NBA and never pull games from the previous season to fill the sample.

- Uses up to the latest 10 completed games from the current NHL season only.
- Requires at least 3 completed current-season games for both teams.
- 0-2 games for either team: the fixture is marked `NEDOSTATEK DAT` and analysis is disabled.
- 3-9 games: analysis is allowed but marked `OMEZENÁ SPOLEHLIVOST`; Value Bet is informational only and no `SÁZET` recommendation is issued.
- 10+ games: the model uses the latest 10 current-season games.
- Previous-season games are excluded completely.

The live NHL model uses the public NHL API for goals for/against, shots on goal, recent goalie save percentage from box scores, and home/away form. The Odds API remains the live odds source.


## Current-season-only FIFA UEFA rule

FIFA / UEFA predictions now use the same data-availability safety logic as NBA and NHL.

- Uses only matches from the current competition season / tournament year for the selected fixture.
- Uses up to the latest 10 completed matches before the selected fixture.
- 0-2 completed matches for either team: the fixture is marked `NEDOSTATEK DAT` and analysis is disabled.
- 3-9 completed matches: analysis is allowed but marked `OMEZENÁ SPOLEHLIVOST`; Value Bet is informational only and no `SÁZET` recommendation is issued.
- 10+ completed matches: the model uses the latest 10 matches from the current season only.
- Previous-season matches are never used as a fallback.
- If the configured API-Football plan does not expose the current season, the fixture is marked unavailable instead of silently using an older season.


## Prediction Tracker

Every successful prediction for a future fixture is persisted before kickoff in a Netlify Blobs store named `prediction-tracker`.

The tracker stores:

- sport
- home and away teams
- fixture/event ID and kickoff time
- prediction timestamp
- bookmaker odds and odds source
- tracked market
- model probability
- Value Bet
- expected/predicted score
- reliability state
- recommendation state
- model data source and season

A fixture is stored under a stable event key, so recalculating the same fixture updates its latest pre-match snapshot instead of creating duplicate backtest rows.

Endpoints:

```
GET /api/tracker?limit=20
GET /api/tracker?sport=nba&limit=50
```

The frontend includes a **Prediction Tracker** section that shows recent stored snapshots. Predictions are not stored when the match has already started or the kickoff date is missing.


## ATP / WTA tennis

The app now supports upcoming ATP and WTA singles matches discovered dynamically from The Odds API.

Tennis uses a rolling 12-month window instead of a season reset:

- fewer than 5 matches for either player in the previous 12 months: `NEDOSTATEK DAT`
- 5-9 matches: `OMEZENÁ SPOLEHLIVOST`
- 10+ matches: standard sample, unless the data for one player is older than 60 days
- no previous-season cutoff is applied; only the last 365 days before the selected match are considered

The tennis model combines:

- overall Elo calculated chronologically over the rolling window
- surface-specific Elo
- recent form from the last 10 matches
- recent form on the selected surface
- tournament surface inferred from the The Odds API tennis sport key / title

Current match-winner odds come from The Odds API. Tennis tournament coverage includes ATP and WTA competitions exposed by its active `tennis_atp_*` and `tennis_wta_*` sport keys.

Historical result data are loaded from Jeff Sackmann-compatible public CSV sources, with an archival mirror fallback. These datasets are CC BY-NC-SA; attribution and non-commercial-use requirements apply.

Tennis predictions are saved to Prediction Tracker with the selected market, price, model probability, Value Bet, predicted winner, surface, reliability state, and prediction timestamp.


## Edge vs Expected ROI

Betting output is split into two different metrics:

- **Edge (percentage points)** = model probability minus the bookmaker market probability after normalizing the market overround.
- **Expected ROI (%)** = `model_probability * decimal_odds - 1`, expressed as a percentage.

The selected market is chosen by the highest Expected ROI. Recommendation logic uses Expected ROI rather than Edge. When reliability is limited, both metrics remain informational only and no `SÁZET` recommendation is emitted.

Prediction Tracker schema v2 stores `edge_pct` and `expected_roi_pct` separately.


## Automatic result settlement

Prediction Tracker now settles completed paper bets automatically.

- A Netlify scheduled function runs hourly on production deploys.
- The Odds API scores endpoint is used for tracked events that have a stored `sport_key` and event ID.
- Czech football can fall back to API-Football using its fixture ID.
- Each settled record stores the actual score/result and a simulated 1-unit bet result.
- Simulated profit is `decimal_odds - 1` units for a win, `-1` unit for a loss, and `0` for a push.
- Tracker API aggregates settled bets into wins/losses/pushes, total simulated profit, total simulated stake, and running ROI.
- Running ROI is `total_profit_units / total_stake_units * 100`.

The Odds API scores endpoint only exposes recently completed games for up to three days, so the scheduled settlement process is intended to capture results shortly after matches finish.
