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
import { extractChanceLigaScoreFromHtml, settlePaperBet, trackerPerformanceSummary } from '../netlify/functions/lib/settlement.mjs';
import {
  calculateTennisModelFromMatches,
  classifyTennisDataAvailability,
  tennisSurfaceFromSportKey
} from '../netlify/functions/lib/tennis.mjs';

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
    roiValues: { home: 3.1, away: -6.4 },
    best: ['home', 3.1],
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
    roiValues: { home_moneyline: 12.4, away_moneyline: -10.1 },
    best: ['home_moneyline', 12.4],
    used: { home: 2.1, away: 1.8 },
    actionable: true,
    limitedReliability: true
  });
  assert.equal(result.value_available, true);
  assert.equal(result.value_informational_only, true);
  assert.equal(result.best_value_pct, 9.5);
  assert.equal(result.best_edge_pct, 9.5);
  assert.equal(result.best_expected_roi_pct, 12.4);
  assert.equal(result.is_actionable, false);
  assert.equal(result.recommendation_allowed, false);
  assert.equal(result.recommendation, 'BEZ DOPORUČENÍ');
  assert.equal(result.recommendation_block_reason, 'OMEZENÁ SPOLEHLIVOST');
  assert.deepEqual(result.market_odds, { home: 2.1, away: 1.8 });
});


test('standard reliability bases recommendation on Expected ROI while keeping Edge separate', () => {
  const result = bettingFields({
    values: { home: 4.0, away: -4.0 },
    roiValues: { home: -1.5, away: -8.0 },
    best: ['home', -1.5],
    used: { home: 1.75, away: 2.2 },
    actionable: true,
    limitedReliability: false
  });

  assert.equal(result.best_edge_pct, 4.0);
  assert.equal(result.best_expected_roi_pct, -1.5);
  assert.equal(result.recommendation, 'NEVÁHAT');
  assert.equal(result.recommendation_allowed, true);
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
    best_edge_pct: 4.7,
    best_expected_roi_pct: null,
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
  assert.equal(snapshot.edge_pct, 4.7);
  assert.equal(snapshot.expected_roi_pct, null);
  assert.equal(snapshot.value_bet_pct, null);
  assert.deepEqual(snapshot.predicted_score, { home: 118.4, away: 113.2 });
  assert.equal(snapshot.reliability.label, 'STANDARDNÍ SPOLEHLIVOST');
  assert.equal(snapshot.is_pre_match, true);
});


test('tennis surface detection maps major tournaments correctly', () => {
  assert.equal(tennisSurfaceFromSportKey('tennis_atp_french_open', 'French Open'), 'Clay');
  assert.equal(tennisSurfaceFromSportKey('tennis_atp_wimbledon', 'Wimbledon'), 'Grass');
  assert.equal(tennisSurfaceFromSportKey('tennis_wta_us_open', 'US Open'), 'Hard');
});

test('tennis rolling Elo model favors player with stronger recent results', () => {
  const matches = [
    { date: '2026-01-01T12:00:00Z', surface: 'Hard', winner: 'Player A', loser: 'Player C' },
    { date: '2026-02-01T12:00:00Z', surface: 'Hard', winner: 'Player A', loser: 'Player D' },
    { date: '2026-03-01T12:00:00Z', surface: 'Hard', winner: 'Player A', loser: 'Player E' },
    { date: '2026-04-01T12:00:00Z', surface: 'Hard', winner: 'Player A', loser: 'Player F' },
    { date: '2026-05-01T12:00:00Z', surface: 'Hard', winner: 'Player G', loser: 'Player B' },
    { date: '2026-06-01T12:00:00Z', surface: 'Hard', winner: 'Player H', loser: 'Player B' },
    { date: '2026-07-01T12:00:00Z', surface: 'Hard', winner: 'Player I', loser: 'Player B' },
    { date: '2026-08-01T12:00:00Z', surface: 'Hard', winner: 'Player J', loser: 'Player B' }
  ];

  const model = calculateTennisModelFromMatches(matches, 'Player A', 'Player B', 'Hard');
  assert.ok(model.probability_a > 0.5);
  assert.ok(model.player_a.elo > model.player_b.elo);
  assert.ok(model.player_a.surface_elo > model.player_b.surface_elo);
  assert.deepEqual(model.actual_match_range, {
    from: '2026-01-01T12:00:00.000Z',
    to: '2026-08-01T12:00:00.000Z'
  });
  assert.equal(model.newest_available_match_date, '2026-08-01T12:00:00.000Z');
});

test('tennis availability uses rolling 12-month thresholds instead of season reset', () => {
  assert.equal(classifyTennisDataAvailability(4, 12).analysis_available, false);
  assert.equal(classifyTennisDataAvailability(5, 9).data_status, 'OMEZENÁ SPOLEHLIVOST');
  assert.equal(
    classifyTennisDataAvailability(
      12,
      15,
      '2026-09-01T12:00:00Z',
      '2026-09-20T12:00:00Z'
    ).data_status,
    'PŘIPRAVENO'
  );
});


test('automatic settlement computes one-unit simulated win and loss correctly', () => {
  const base = {
    tracked_market: 'home',
    tracked_odds: 2.5,
    match: { home_team: 'A', away_team: 'B' }
  };

  const win = settlePaperBet(base, { home: 2, away: 1 }, 'test', '2026-09-20T20:00:00Z');
  assert.equal(win.status, 'SETTLED');
  assert.equal(win.simulated_bet.outcome, 'WIN');
  assert.equal(win.simulated_bet.stake_units, 1);
  assert.equal(win.simulated_bet.profit_units, 1.5);

  const loss = settlePaperBet(base, { home: 0, away: 1 }, 'test', '2026-09-20T20:00:00Z');
  assert.equal(loss.simulated_bet.outcome, 'LOSS');
  assert.equal(loss.simulated_bet.profit_units, -1);
});

test('Czech result settles actual score even when no real odds were tracked', () => {
  const snapshot = {
    tracked_market: null,
    tracked_odds: null,
    match: { home_team: 'Sigma Olomouc', away_team: 'Sparta Praha' }
  };
  const settled = settlePaperBet(
    snapshot,
    { home: 1, away: 2 },
    'chance-liga-official',
    '2026-09-20T18:00:00Z'
  );
  assert.equal(settled.status, 'SETTLED');
  assert.deepEqual(settled.actual_score, { home: 1, away: 2 });
  assert.equal(settled.actual_result, 'AWAY');
  assert.equal(settled.simulated_bet, null);
});

test('Chance Liga result parser matches date, teams and final score', () => {
  const html = `
    <div>#9 20/09/26 ne 15:00 SIG 1:2<span>video</span> ACS</div>
    <div>#9 20/09/26 SKS 3:0 PLZ</div>
  `;
  const snapshot = {
    match: {
      home_team: 'Sigma Olomouc',
      away_team: 'Sparta Praha',
      commence_time: '2026-09-20T13:00:00.000Z'
    }
  };
  assert.deepEqual(extractChanceLigaScoreFromHtml(html, snapshot), { home: 1, away: 2 });
});

test('Prediction Tracker performance summary calculates running ROI from settled paper bets', () => {
  const rows = [
    { settlement: { status: 'SETTLED', simulated_bet: { stake_units: 1, profit_units: 1.5, outcome: 'WIN' } } },
    { settlement: { status: 'SETTLED', simulated_bet: { stake_units: 1, profit_units: -1, outcome: 'LOSS' } } },
    { settlement: { status: 'SETTLED', simulated_bet: { stake_units: 1, profit_units: 0, outcome: 'PUSH' } } },
    { settlement: null }
  ];
  const summary = trackerPerformanceSummary(rows);
  assert.deepEqual(summary, {
    settled_bets: 3,
    wins: 1,
    losses: 1,
    pushes: 1,
    stake_units: 3,
    profit_units: 0.5,
    roi_pct: 16.7
  });
});
