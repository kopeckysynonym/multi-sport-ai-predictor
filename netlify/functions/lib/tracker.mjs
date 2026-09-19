import { getDeployStore, getStore } from '@netlify/blobs';

const STORE_NAME = 'prediction-tracker';

function isProductionDeploy() {
  const context =
    globalThis.Netlify?.context?.deploy?.context ||
    globalThis.Netlify?.env?.get?.('CONTEXT') ||
    null;
  return context === 'production';
}

function trackerStore() {
  return isProductionDeploy()
    ? getStore(STORE_NAME, { consistency: 'strong' })
    : getDeployStore(STORE_NAME);
}

function safePart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function trackedProbability(result) {
  const market = result?.best_value_market;
  if (!market) return null;
  const direct = Number(result?.probabilities?.[market]);
  if (Number.isFinite(direct)) return direct;

  const alias = {
    home_moneyline: 'home',
    away_moneyline: 'away',
  }[market];
  const aliased = alias ? Number(result?.probabilities?.[alias]) : NaN;
  return Number.isFinite(aliased) ? aliased : null;
}

function trackedOdds(result) {
  const market = result?.best_value_market;
  if (!market) return null;
  const odds = result?.market_odds || {};
  const direct = Number(odds?.[market]);
  if (Number.isFinite(direct)) return direct;

  const alias = {
    home_moneyline: 'home',
    away_moneyline: 'away',
  }[market];
  const aliased = alias ? Number(odds?.[alias]) : NaN;
  return Number.isFinite(aliased) ? aliased : null;
}

function fixtureIdentity(result, fixture) {
  return String(
    fixture?.event_id ||
    fixture?.fixture_id ||
    fixture?.id ||
    result?.selected_fixture?.event_id ||
    result?.selected_fixture?.fixture_id ||
    result?.selected_fixture?.id ||
    ''
  );
}

export function buildPredictionSnapshot(result, fixture = null, now = new Date()) {
  const predictionTime = now.toISOString();
  const matchDate = result?.match_date || fixture?.commence_time || result?.selected_fixture?.commence_time || null;
  const matchTime = Date.parse(matchDate || '');
  const predictionMs = now.getTime();

  const id = fixtureIdentity(result, fixture);
  const match = {
    home_team: result?.team_a || fixture?.home_team || null,
    away_team: result?.team_b || fixture?.away_team || null,
    commence_time: matchDate,
    league: fixture?.league || result?.selected_fixture?.league || null,
    event_id: fixture?.event_id || result?.selected_fixture?.event_id || null,
    fixture_id: fixture?.fixture_id || result?.selected_fixture?.fixture_id || null,
  };

  return {
    schema_version: 1,
    record_id: id || `${safePart(match.home_team)}-${safePart(match.away_team)}-${safePart(matchDate)}`,
    sport: result?.sport || null,
    sport_label: result?.sport_label || null,
    match,
    prediction_time: predictionTime,
    bookmaker_odds: result?.market_odds || null,
    odds_mode: result?.odds_mode || null,
    tracked_market: result?.best_value_market || null,
    tracked_odds: trackedOdds(result),
    model_probability_pct: trackedProbability(result),
    probabilities: result?.probabilities || null,
    value_bet_pct: Number.isFinite(Number(result?.best_value_pct))
      ? Number(result.best_value_pct)
      : null,
    value_available: Boolean(result?.value_available),
    value_informational_only: Boolean(result?.value_informational_only),
    predicted_score: result?.expected_score || null,
    most_likely_score: result?.most_likely_score || null,
    reliability: {
      label: result?.reliability_label || null,
      limited: Boolean(result?.limited_reliability),
      recommendation_allowed: Boolean(result?.recommendation_allowed),
    },
    recommendation: result?.recommendation || 'BEZ DOPORUČENÍ',
    data_mode: result?.data_mode || null,
    data_season_label: result?.data_season_label || null,
    historical_match_range: result?.historical_match_range || null,
    is_pre_match: Number.isFinite(matchTime) ? predictionMs < matchTime : false,
  };
}

export async function savePredictionSnapshot(result, fixture = null, now = new Date()) {
  const snapshot = buildPredictionSnapshot(result, fixture, now);

  if (!snapshot.match.commence_time || !snapshot.is_pre_match) {
    return {
      saved: false,
      reason: 'MATCH_ALREADY_STARTED_OR_DATE_MISSING',
      snapshot: null,
    };
  }

  const eventKey = safePart(snapshot.record_id);
  const key = `predictions/${safePart(snapshot.sport)}/${eventKey}.json`;
  const store = trackerStore();
  await store.setJSON(key, snapshot);

  return {
    saved: true,
    key,
    snapshot,
  };
}

export async function listPredictionSnapshots({ sport = null, limit = 20 } = {}) {
  const store = trackerStore();
  const prefix = sport ? `predictions/${safePart(sport)}/` : 'predictions/';
  const { blobs } = await store.list({ prefix });

  const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
  const values = await Promise.all(
    blobs.map(async blob => {
      try {
        return await store.get(blob.key, { type: 'json' });
      } catch {
        return null;
      }
    })
  );

  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b?.prediction_time || 0) - Date.parse(a?.prediction_time || 0))
    .slice(0, capped);
}
