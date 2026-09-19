import {
  insertPredictionIfUnique,
  updatePredictionFieldsByPredictionId,
} from './sharepoint.mjs';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function modelVersion(sport) {
  return {
    cz_football: 'football-poisson-v1',
    fifa: 'football-poisson-v1',
    nba: 'nba-current-season-v1',
    nhl: 'nhl-poisson-v1',
    tennis: 'tennis-rolling-12m-elo-v1',
  }[sport] || 'model-v1';
}

function sourceEventKey(snapshot) {
  const fixtureId = snapshot?.match?.fixture_id;
  const eventId = snapshot?.match?.event_id;
  if (snapshot?.sport === 'cz_football' && fixtureId) return `apifootball:${fixtureId}`;
  if (eventId) return `oddsapi:${eventId}`;
  if (fixtureId) return `fixture:${fixtureId}`;
  return `tracker:${snapshot?.record_id || 'unknown'}`;
}

export function predictionIdFromSnapshot(snapshot) {
  return `pred:${snapshot?.sport || 'unknown'}:${snapshot?.record_id || 'unknown'}`;
}

function reliabilityValue(snapshot) {
  if (snapshot?.reliability?.limited) return 'LIMITED';
  const label = String(snapshot?.reliability?.label || '').toUpperCase();
  if (label.includes('OMEZEN')) return 'LIMITED';
  if (label.includes('STANDARD')) return 'STANDARD';
  return 'UNKNOWN';
}

function marketSelection(snapshot) {
  const market = snapshot?.tracked_market;
  if (!market) return null;
  if (market === 'draw') return 'DRAW';
  if (market.startsWith('home')) return snapshot?.match?.home_team || null;
  if (market.startsWith('away')) return snapshot?.match?.away_team || null;
  return market;
}

function recommendationValue(snapshot) {
  if (!snapshot?.reliability?.recommendation_allowed) return 'NO_RECOMMENDATION';
  const roi = finite(snapshot?.expected_roi_pct);
  return roi != null && roi > 0 ? 'BET' : 'NO_BET';
}

function metadata(snapshot) {
  return JSON.stringify({
    tracker_schema_version: snapshot?.schema_version ?? null,
    odds_mode: snapshot?.odds_mode ?? null,
    probabilities: snapshot?.probabilities ?? null,
    data_season_label: snapshot?.data_season_label ?? null,
    provider: snapshot?.match?.provider ?? null,
    value_informational_only: Boolean(snapshot?.value_informational_only),
  });
}

export function sharePointFieldsFromSnapshot(snapshot) {
  const odds = finite(snapshot?.tracked_odds);
  const modelProbability = finite(snapshot?.model_probability_pct);
  const edge = finite(snapshot?.edge_pct);
  const expectedRoi = finite(snapshot?.expected_roi_pct);
  const marketProbability =
    modelProbability != null && edge != null
      ? Math.max(0, Math.min(100, modelProbability - edge))
      : null;
  const oddsAvailable = Boolean(
    snapshot?.value_available &&
    snapshot?.tracked_market &&
    odds != null &&
    odds > 1
  );

  const fields = {
    Title: `${snapshot?.match?.home_team || 'Team A'} vs ${snapshot?.match?.away_team || 'Team B'}`,
    PredictionId: predictionIdFromSnapshot(snapshot),
    SchemaVersion: 3,
    SourceEventKey: sourceEventKey(snapshot),
    EventId: snapshot?.match?.event_id || undefined,
    FixtureId: snapshot?.match?.fixture_id || undefined,
    SportKey: snapshot?.match?.sport_key || undefined,
    Sport: snapshot?.sport,
    SportLabel: snapshot?.sport_label || snapshot?.sport || 'Sport',
    Competition: snapshot?.match?.league || undefined,
    TeamA: snapshot?.match?.home_team,
    TeamB: snapshot?.match?.away_team,
    MatchTime: validIso(snapshot?.match?.commence_time),
    PredictionTime: validIso(snapshot?.prediction_time),
    IsPreMatch: Boolean(snapshot?.is_pre_match),
    ModelName: snapshot?.model_name || snapshot?.model || 'Multi-Sport AI Predictor',
    ModelVersion: snapshot?.model_version || modelVersion(snapshot?.sport),
    DataMode: snapshot?.data_mode || 'unknown',
    Reliability: reliabilityValue(snapshot),
    LimitedReliability: Boolean(snapshot?.reliability?.limited),
    DataSampleA: finite(snapshot?.data_matches_used?.team_a) ?? undefined,
    DataSampleB: finite(snapshot?.data_matches_used?.team_b) ?? undefined,
    HistoricalFrom: validIso(snapshot?.historical_match_range?.from) || undefined,
    HistoricalTo: validIso(snapshot?.historical_match_range?.to) || undefined,
    RollingFrom: validIso(snapshot?.rolling_window?.from) || undefined,
    RollingTo: validIso(snapshot?.rolling_window?.to) || undefined,
    LatestDataDate: validIso(snapshot?.latest_available_data_date) || undefined,
    DataAgeDays: finite(snapshot?.latest_available_data_age_days ?? snapshot?.data_age_days) ?? undefined,
    OddsAvailable: oddsAvailable,
    OddsSource: snapshot?.odds_mode || undefined,
    OddsSnapshotTime: validIso(snapshot?.prediction_time) || undefined,
    Bookmaker: oddsAvailable ? 'Consensus' : undefined,
    Market: oddsAvailable ? snapshot?.tracked_market : undefined,
    Selection: oddsAvailable ? marketSelection(snapshot) : undefined,
    TrackedOdds: oddsAvailable ? odds : undefined,
    ModelProbabilityPct: modelProbability ?? 0,
    RawImpliedProbabilityPct: oddsAvailable ? Number((100 / odds).toFixed(2)) : undefined,
    MarketProbabilityPct: oddsAvailable && marketProbability != null
      ? Number(marketProbability.toFixed(2))
      : undefined,
    EdgePctPoints: oddsAvailable ? edge ?? undefined : undefined,
    ExpectedRoiPct: oddsAvailable ? expectedRoi ?? undefined : undefined,
    PredictedWinner: snapshot?.predicted_winner || undefined,
    PredictedScoreA: finite(snapshot?.predicted_score?.home) ?? undefined,
    PredictedScoreB: finite(snapshot?.predicted_score?.away) ?? undefined,
    RecommendationAllowed: Boolean(snapshot?.reliability?.recommendation_allowed),
    Recommendation: recommendationValue(snapshot),
    SettlementStatus: 'PENDING',
    StakeUnits: oddsAvailable ? 1 : 0,
    MetadataJson: metadata(snapshot),
  };

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
  );
}

export async function syncPredictionSnapshotToSharePoint(snapshot) {
  if (!snapshot?.is_pre_match) {
    return { synced: false, reason: 'NOT_PREMATCH' };
  }

  const result = await insertPredictionIfUnique(sharePointFieldsFromSnapshot(snapshot));
  return {
    synced: true,
    created: Boolean(result.created),
    duplicate: Boolean(result.duplicate),
    item_id: result.item_id || null,
    duplicate_field: result.duplicate_field || null,
  };
}

function actualResultValue(settlement) {
  if (settlement?.actual_result === 'HOME') return 'A';
  if (settlement?.actual_result === 'AWAY') return 'B';
  if (settlement?.actual_result === 'DRAW') return 'DRAW';
  return null;
}

function actualWinner(snapshot, settlement) {
  const actual = settlement?.actual_result;
  if (actual === 'HOME') return snapshot?.match?.home_team || null;
  if (actual === 'AWAY') return snapshot?.match?.away_team || null;
  if (actual === 'DRAW') return 'DRAW';
  return null;
}

export function sharePointSettlementFields(snapshot, settlement) {
  const bet = settlement?.simulated_bet || {};
  const fields = {
    SettlementStatus: settlement?.status || 'SETTLED',
    ActualScoreA: finite(settlement?.actual_score?.home) ?? undefined,
    ActualScoreB: finite(settlement?.actual_score?.away) ?? undefined,
    ActualResult: actualResultValue(settlement) || undefined,
    ActualWinner: actualWinner(snapshot, settlement) || undefined,
    BetOutcome: bet?.outcome || undefined,
    StakeUnits: finite(bet?.stake_units) ?? undefined,
    ProfitUnits: finite(bet?.profit_units) ?? undefined,
    ReturnUnits: finite(bet?.return_units) ?? undefined,
    SettledAt: validIso(settlement?.settled_at) || undefined,
    ResultSource: settlement?.source || undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
  );
}

export async function syncSettlementToSharePoint(snapshot, settlement) {
  const predictionId = predictionIdFromSnapshot(snapshot);
  const fields = sharePointSettlementFields(snapshot, settlement);
  const result = await updatePredictionFieldsByPredictionId(predictionId, fields);
  return {
    synced: true,
    item_id: result.item_id || null,
    prediction_id: predictionId,
  };
}
