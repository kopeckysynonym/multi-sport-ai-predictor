import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SharePointPredictionError,
  escapeODataString,
  validatePredictionFields,
} from '../netlify/functions/lib/sharepoint.mjs';
import {
  predictionIdFromSnapshot,
  sharePointFieldsFromSnapshot,
  sharePointSettlementFields,
} from '../netlify/functions/lib/sharepoint-sync.mjs';

function validFields() {
  return {
    Title: 'Peyton Stearns vs Iva Jovic',
    PredictionId: 'pred-tennis-example',
    SchemaVersion: 3,
    SourceEventKey: 'oddsapi:event-123',
    Sport: 'tennis',
    SportLabel: 'Tenis ATP/WTA',
    TeamA: 'Peyton Stearns',
    TeamB: 'Iva Jovic',
    MatchTime: '2026-09-20T01:00:00Z',
    PredictionTime: '2026-09-19T14:43:00Z',
    IsPreMatch: true,
    ModelName: 'Rolling 12m Elo',
    ModelVersion: 'tennis-v1.0',
    DataMode: 'tennis-rolling-12m-elo',
    Reliability: 'LIMITED',
    LimitedReliability: true,
    ModelProbabilityPct: 50.9,
    OddsAvailable: true,
    Market: 'home',
    Selection: 'Peyton Stearns',
    TrackedOdds: 3.49,
    MarketProbabilityPct: 27.2,
    EdgePctPoints: 23.7,
    ExpectedRoiPct: 77.6,
    RecommendationAllowed: false,
    Recommendation: 'NO_RECOMMENDATION',
    SettlementStatus: 'PENDING',
    StakeUnits: 1,
  };
}

test('SharePoint OData string values escape apostrophes', () => {
  assert.equal(escapeODataString("O'Brien"), "O''Brien");
});

test('SharePoint prediction validation accepts a complete pre-match payload', () => {
  const input = validFields();
  const fields = validatePredictionFields({ ...input, UnknownField: 'ignored' });
  assert.equal(fields.PredictionId, input.PredictionId);
  assert.equal(fields.SourceEventKey, input.SourceEventKey);
  assert.equal(fields.UnknownField, undefined);
});

test('SharePoint prediction validation requires SourceEventKey', () => {
  const fields = validFields();
  delete fields.SourceEventKey;

  assert.throws(
    () => validatePredictionFields(fields),
    error =>
      error instanceof SharePointPredictionError &&
      error.code === 'MISSING_REQUIRED_FIELDS'
  );
});

test('SharePoint prediction validation requires odds metrics when OddsAvailable is true', () => {
  const fields = validFields();
  delete fields.ExpectedRoiPct;

  assert.throws(
    () => validatePredictionFields(fields),
    error =>
      error instanceof SharePointPredictionError &&
      error.code === 'MISSING_ODDS_FIELDS'
  );
});

test('SharePoint prediction validation rejects non pre-match timestamps', () => {
  const fields = validFields();
  fields.PredictionTime = fields.MatchTime;

  assert.throws(
    () => validatePredictionFields(fields),
    error =>
      error instanceof SharePointPredictionError &&
      error.code === 'NOT_PREMATCH'
  );
});


test('SharePoint tracker mapping keeps Edge in percentage points and Expected ROI separately', () => {
  const snapshot = {
    schema_version: 3,
    record_id: 'tennis-event-123',
    sport: 'tennis',
    sport_label: 'Tenis ATP/WTA',
    match: {
      home_team: 'Peyton Stearns',
      away_team: 'Iva Jovic',
      commence_time: '2026-09-20T01:00:00Z',
      event_id: 'event-123',
      sport_key: 'tennis_wta_guadalajara',
      league: 'WTA Guadalajara Open',
      provider: 'the-odds-api',
    },
    prediction_time: '2026-09-19T14:43:00Z',
    tracked_market: 'home',
    tracked_odds: 3.49,
    model_probability_pct: 50.9,
    edge_pct: 23.7,
    expected_roi_pct: 77.6,
    value_available: true,
    predicted_winner: 'Peyton Stearns',
    reliability: {
      label: 'OMEZENÁ SPOLEHLIVOST',
      limited: true,
      recommendation_allowed: false,
    },
    data_mode: 'tennis-rolling-12m-elo',
    model_name: 'Rolling 12m Elo + surface Elo + recent form',
    data_matches_used: { team_a: 29, team_b: 40 },
    rolling_window: {
      from: '2025-09-20T00:00:00Z',
      to: '2026-09-20T00:00:00Z',
    },
    historical_match_range: {
      from: '2025-09-24T00:00:00Z',
      to: '2026-05-25T00:00:00Z',
    },
    latest_available_data_date: '2026-05-25T00:00:00Z',
    latest_available_data_age_days: 117,
    is_pre_match: true,
  };

  const fields = sharePointFieldsFromSnapshot(snapshot);
  assert.equal(fields.PredictionId, predictionIdFromSnapshot(snapshot));
  assert.equal(fields.SourceEventKey, 'oddsapi:event-123');
  assert.equal(fields.EdgePctPoints, 23.7);
  assert.equal(fields.ExpectedRoiPct, 77.6);
  assert.equal(fields.MarketProbabilityPct, 27.2);
  assert.equal(fields.Reliability, 'LIMITED');
  assert.equal(fields.Recommendation, 'NO_RECOMMENDATION');
  assert.equal(fields.StakeUnits, 1);
});

test('SharePoint settlement mapping stores simulated P/L separately from return', () => {
  const snapshot = {
    match: {
      home_team: 'Peyton Stearns',
      away_team: 'Iva Jovic',
    },
  };
  const settlement = {
    status: 'SETTLED',
    settled_at: '2026-09-20T04:15:00Z',
    source: 'the-odds-api-scores',
    actual_score: { home: 2, away: 0 },
    actual_result: 'HOME',
    simulated_bet: {
      stake_units: 1,
      outcome: 'WIN',
      profit_units: 2.49,
      return_units: 3.49,
    },
  };

  const fields = sharePointSettlementFields(snapshot, settlement);
  assert.equal(fields.ActualResult, 'A');
  assert.equal(fields.ActualWinner, 'Peyton Stearns');
  assert.equal(fields.BetOutcome, 'WIN');
  assert.equal(fields.ProfitUnits, 2.49);
  assert.equal(fields.ReturnUnits, 3.49);
});
