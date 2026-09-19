import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApiFootballCzOdds, summarizeApiFootballMatchWinner } from '../netlify/functions/lib/providers.mjs';
import { predictNba } from '../netlify/functions/lib/predictor.mjs';

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

test('demo odds never produce an actionable betting recommendation', async () => {
  process.env.LIVE_DATA_ENABLED = 'false';
  const result = await predictNba('Boston Celtics', 'Denver Nuggets');
  assert.equal(result.odds_mode, 'demo');
  assert.equal(result.is_actionable, false);
  assert.equal(result.recommendation, 'BEZ DOPORUČENÍ');
  assert.equal(result.best_value_pct, null);
  assert.equal(result.market_odds, null);
  assert.ok(result.demo_market_odds);
});
