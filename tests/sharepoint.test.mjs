import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SharePointPredictionError,
  escapeODataString,
  validatePredictionFields,
} from '../netlify/functions/lib/sharepoint.mjs';

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
