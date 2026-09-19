import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFifaDataAvailability,
  classifyNbaDataAvailability,
  classifyNhlDataAvailability,
  fifaSeasonForFixture,
  loadApiFootballCzOdds,
  nbaCurrentSeasonScheduleQueries,
  nhlSeasonId,
  summarizeApiFootballMatchWinner
} from '../netlify/functions/lib/providers.mjs';
import { bettingFields } from '../netlify/functions/lib/predictor.mjs';
import { buildPredictionSnapshot } from '../netlify/functions/lib/tracker.mjs';

const originalFetch = global.fetch;
const originalFootballKey = process.env.API_FOOTBALL_KEY;
const originalLive = process.env.LIVE_DATA_ENABLED;
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalFootballKey === undefined) delete process.env.API_FOOTBALL_KEY;
  else process.env.API_FOOTBALL_KEY = originalFootballKey;
  if (originalLive === undefined) delete process.env.LIVE_DATA_ENABLED;
  else process.env.LIVE_DATA_ENABLED = originalLive;
});

test('summarizes API-Football Match Winner odds across bookmakers', () => {
  const result = summarizeApiFootballMatchWinner({
    response: [{
      bookmakers: [
        { name: 'A', bets: [{ id: 1, name: 'Match Winner', values: [
          { value: 'Home', odd: '1.80' }, { value: 'Draw', odd: '3.50' }, { value: 'Away', odd: '4.20' }
        ] }] },
        { name: 'B', bets: [{ id: 1, name: 'Match Winner', values: [
          { value: 'Home', odd: '1.90' }, { value: 'Draw', odd: '3.40' }, { value: 'Away', odd: '4.00' }
        ] }] }
      ]
    }]
  });
  assert.deepEqual(result, { home: 1.85, draw: 3.45, away: 4.1, bookmakers: 2 });
});

test('loads Czech 1X2 odds from API-Football for the selected home-away fixture', async () => {
  process.env.API_FOOTBALL_KEY = 'test-key';
  const future = new Date(Date.now() + 7 * 86400000).toISOString();

  global.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/teams')) {
      const search = url.searchParams.get('search');
      if (search === 'Slavia Praha') return response({ errors: [], response: [{ team: { id: 560, name: 'Slavia Praha' } }] });
      if (search === 'Sparta Praha') return response({ errors: [], response: [{ team: { id: 628, name: 'Sparta Praha' } }] });
    }
    if (url.pathname.endsWith('/fixtures/headtohead')) {
      return response({
        errors: [],
        response: [{
          fixture: { id: 999, date: future, status: { short: 'NS' } },
          teams: { home: { id: 560 }, away: { id: 628 } }
        }]
      });
    }
    if (url.pathname.endsWith('/odds')) {
      assert.equal(url.searchParams.get('fixture'), '999');
      assert.equal(url.searchParams.get('bet'), '1');
      return response({
        errors: [],
        response: [{
          bookmakers: [{
            name: 'Book',
            bets: [{
              id: 1,
              name: 'Match Winner',
              values: [
                { value: 'Home', odd: '1.90' },
                { value: 'Draw', odd: '3.40' },
                { value: 'Away', odd: '4.00' }
              ]
            }]
          }]
        }]
      });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const odds = await loadApiFootballCzOdds('Slavia Praha', 'Sparta Praha');
  assert.equal(odds.home, 1.9);
  assert.equal(odds.draw, 3.4);
  assert.equal(odds.away, 4);
  assert.equal(odds.fixture_id, 999);
  assert.equal(odds.provider, 'API-Football');
});

test('demo odds never produce an actionable betting recommendation', () => {
  const result = bettingFields({
    values: { home: 5.2, away: -5.2 },
    best: ['home', 5.2],
    used: { home: 1.9, away: 2.0 },
    actionable: false,
    limitedReliability: false
  });
  assert.equal(result.is_actionable, false);
  assert.equal(result.value_available, false);
  assert.equal(result.recommendation, 'BEZ DOPORUČENÍ');
  assert.equal(result.best_value_pct, null);
  assert.equal(result.market_odds, null);
  assert.ok(result.demo_market_odds);
});

test('limited reliability keeps real value bet informational and blocks SÁZET', () => {
  const result = bettingFields({
    values: { home_moneyline: 9.5, away_moneyline: -9.5 },
    best: ['home_moneyline', 9.5],
    used: { home: 2.1, away: 1.8 },
    actionable: true,
    limitedReliability: true
  });
  assert.equal(result.value_available, true);
  assert.equal(result.value_informational_only, true);
  assert.equal(result.best_value_pct, 9.5);
  assert.equal(result.is_actionable, false);
  assert.equal(result.recommendation_allowed, false);
  assert.equal(result.recommendation, 'BEZ DOPORUČENÍ');
  assert.equal(result.recommendation_block_reason, 'OMEZENÁ SPOLEHLIVOST');
  assert.deepEqual(result.market_odds, { home: 2.1, away: 1.8 });
});


test('NBA schedule queries never include a previous season after the new season starts', () => {
  const queries = nbaCurrentSeasonScheduleQueries('2026-10-20T19:00:00Z');
  assert.deepEqual(queries, [[2027, 2], [2027, 3]]);
  assert.equal(queries.some(([season]) => season === 2026), false);
});


test('NBA upcoming availability blocks analysis when either team has 0-2 current-season games', () => {
  assert.deepEqual(
    classifyNbaDataAvailability(0, 0),
    {
      analysis_available: false,
      data_status: 'NEDOSTATEK DAT',
      reliability_status: 'NEDOSTATEK DAT',
      minimum_completed_games: 0
    }
  );

  assert.equal(classifyNbaDataAvailability(2, 8).analysis_available, false);
  assert.equal(classifyNbaDataAvailability(2, 8).data_status, 'NEDOSTATEK DAT');
  assert.equal(classifyNbaDataAvailability(3, 9).analysis_available, true);
  assert.equal(classifyNbaDataAvailability(3, 9).data_status, 'OMEZENÁ SPOLEHLIVOST');
  assert.equal(classifyNbaDataAvailability(10, 12).data_status, 'PŘIPRAVENO');
});


test('NHL upcoming availability blocks analysis when either team has 0-2 current-season games', () => {
  assert.equal(nhlSeasonId('2026-10-20T19:00:00Z'), 20262027);
  assert.equal(nhlSeasonId('2027-02-10T19:00:00Z'), 20262027);

  const blocked = classifyNhlDataAvailability(2, 7);
  assert.equal(blocked.analysis_available, false);
  assert.equal(blocked.data_status, 'NEDOSTATEK DAT');

  const limited = classifyNhlDataAvailability(4, 8);
  assert.equal(limited.analysis_available, true);
  assert.equal(limited.data_status, 'OMEZENÁ SPOLEHLIVOST');

  const ready = classifyNhlDataAvailability(10, 12);
  assert.equal(ready.analysis_available, true);
  assert.equal(ready.data_status, 'PŘIPRAVENO');
});


test('FIFA UEFA availability follows the 0-2 / 3-9 / 10+ current-season rule', () => {
  assert.equal(
    fifaSeasonForFixture({
      commence_time: '2026-10-20T19:00:00Z',
      sport_key: 'soccer_uefa_champs_league'
    }),
    2026
  );
  assert.equal(
    fifaSeasonForFixture({
      commence_time: '2026-06-20T19:00:00Z',
      sport_key: 'soccer_fifa_world_cup'
    }),
    2026
  );

  const blocked = classifyFifaDataAvailability(2, 6);
  assert.equal(blocked.analysis_available, false);
  assert.equal(blocked.data_status, 'NEDOSTATEK DAT');

  const limited = classifyFifaDataAvailability(4, 9);
  assert.equal(limited.analysis_available, true);
  assert.equal(limited.data_status, 'OMEZENÁ SPOLEHLIVOST');

  const ready = classifyFifaDataAvailability(10, 14);
  assert.equal(ready.analysis_available, true);
  assert.equal(ready.data_status, 'PŘIPRAVENO');
});


test('Prediction Tracker snapshot contains required pre-match fields', () => {
  const now = new Date('2026-09-19T10:00:00Z');
  const result = {
    sport: 'nba',
    sport_label: 'NBA',
    team_a: 'Boston Celtics',
    team_b: 'Denver Nuggets',
    match_date: '2026-09-20T18:00:00Z',
    market_odds: { home: 1.91, away: 2.02 },
    odds_mode: 'the-odds-api-live',
    best_value_market: 'home_moneyline',
    best_value_pct: 4.7,
    value_available: true,
    value_informational_only: false,
    probabilities: { home_moneyline: 57.1, away_moneyline: 42.9 },
    expected_score: { home: 118.4, away: 113.2 },
    reliability_label: 'STANDARDNÍ SPOLEHLIVOST',
    limited_reliability: false,
    recommendation_allowed: true,
    recommendation: 'SÁZET',
    data_mode: 'espn-nba-current-season-last10',
    data_season_label: '2026/27'
  };
  const fixture = {
    event_id: 'evt-123',
    home_team: 'Boston Celtics',
    away_team: 'Denver Nuggets',
    commence_time: '2026-09-20T18:00:00Z',
    league: 'NBA'
  };

  const snapshot = buildPredictionSnapshot(result, fixture, now);
  assert.equal(snapshot.sport, 'nba');
  assert.equal(snapshot.match.home_team, 'Boston Celtics');
  assert.equal(snapshot.prediction_time, '2026-09-19T10:00:00.000Z');
  assert.equal(snapshot.tracked_odds, 1.91);
  assert.equal(snapshot.model_probability_pct, 57.1);
  assert.equal(snapshot.value_bet_pct, 4.7);
  assert.deepEqual(snapshot.predicted_score, { home: 118.4, away: 113.2 });
  assert.equal(snapshot.reliability.label, 'STANDARDNÍ SPOLEHLIVOST');
  assert.equal(snapshot.is_pre_match, true);
});
