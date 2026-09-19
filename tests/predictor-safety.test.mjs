import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNbaDataAvailability,
  classifyNhlDataAvailability,
  loadApiFootballCzOdds,
  nbaCurrentSeasonScheduleQueries,
  nhlSeasonId,
  summarizeApiFootballMatchWinner
} from '../netlify/functions/lib/providers.mjs';
import { bettingFields } from '../netlify/functions/lib/predictor.mjs';

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
