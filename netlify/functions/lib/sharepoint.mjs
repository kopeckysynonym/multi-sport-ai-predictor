const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const REQUIRED_FIELDS = [
  'Title',
  'PredictionId',
  'SchemaVersion',
  'SourceEventKey',
  'Sport',
  'SportLabel',
  'TeamA',
  'TeamB',
  'MatchTime',
  'PredictionTime',
  'IsPreMatch',
  'ModelName',
  'ModelVersion',
  'DataMode',
  'Reliability',
  'LimitedReliability',
  'ModelProbabilityPct',
  'OddsAvailable',
  'RecommendationAllowed',
  'Recommendation',
  'SettlementStatus',
  'StakeUnits',
];

const ODDS_REQUIRED_FIELDS = [
  'Market',
  'Selection',
  'TrackedOdds',
  'MarketProbabilityPct',
  'EdgePctPoints',
  'ExpectedRoiPct',
];

const ALLOWED_FIELDS = new Set([
  'Title',
  'PredictionId',
  'SchemaVersion',
  'SourceEventKey',
  'EventId',
  'FixtureId',
  'SportKey',
  'Sport',
  'SportLabel',
  'Competition',
  'TeamA',
  'TeamB',
  'MatchTime',
  'PredictionTime',
  'IsPreMatch',
  'ModelName',
  'ModelVersion',
  'DataMode',
  'Reliability',
  'LimitedReliability',
  'DataSampleA',
  'DataSampleB',
  'HistoricalFrom',
  'HistoricalTo',
  'RollingFrom',
  'RollingTo',
  'LatestDataDate',
  'DataAgeDays',
  'OddsAvailable',
  'OddsSource',
  'OddsSnapshotTime',
  'Bookmaker',
  'Market',
  'Selection',
  'TrackedOdds',
  'ModelProbabilityPct',
  'RawImpliedProbabilityPct',
  'MarketProbabilityPct',
  'MarketOverroundPct',
  'EdgePctPoints',
  'ExpectedRoiPct',
  'PredictedWinner',
  'PredictedScoreA',
  'PredictedScoreB',
  'RecommendationAllowed',
  'Recommendation',
  'SettlementStatus',
  'ActualScoreA',
  'ActualScoreB',
  'ActualResult',
  'ActualWinner',
  'BetOutcome',
  'StakeUnits',
  'ProfitUnits',
  'ReturnUnits',
  'SettledAt',
  'ResultSource',
  'ClosingOdds',
  'ClosingOddsTime',
  'ClvPct',
  'MetadataJson',
]);

export class SharePointPredictionError extends Error {
  constructor(message, { status = 500, code = 'SHAREPOINT_ERROR', details = null } = {}) {
    super(message);
    this.name = 'SharePointPredictionError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || null;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) {
    throw new SharePointPredictionError(`Chybí Netlify environment variable ${name}.`, {
      status: 503,
      code: 'SHAREPOINT_NOT_CONFIGURED',
    });
  }
  return value;
}

function graphItemsUrl(siteId, listId) {
  return `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/items`;
}

function parseGraphError(payload) {
  return payload?.error?.message || payload?.error?.code || null;
}

async function graphRequest(url, { token, method = 'GET', body = null } = {}) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (body != null) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'GRAPH_TIMEOUT'
      : 'GRAPH_NETWORK_ERROR';
    throw new SharePointPredictionError('Microsoft Graph request selhal.', {
      status: code === 'GRAPH_TIMEOUT' ? 504 : 502,
      code,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SharePointPredictionError(
      parseGraphError(payload) || `Microsoft Graph HTTP ${response.status}.`,
      {
        status: response.status === 401 || response.status === 403 ? 502 : response.status,
        code: payload?.error?.code || `GRAPH_HTTP_${response.status}`,
        details: { graph_status: response.status },
      }
    );
  }
  return payload;
}

export function escapeODataString(value) {
  return String(value).replaceAll("'", "''");
}

export function validatePredictionFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SharePointPredictionError('Body musí obsahovat objekt fields.', {
      status: 400,
      code: 'INVALID_FIELDS',
    });
  }

  const fields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value !== undefined && value !== null) fields[key] = value;
  }

  const missing = REQUIRED_FIELDS.filter(name =>
    fields[name] === undefined ||
    fields[name] === null ||
    (typeof fields[name] === 'string' && !fields[name].trim())
  );
  if (missing.length) {
    throw new SharePointPredictionError(`Chybí povinná pole: ${missing.join(', ')}.`, {
      status: 400,
      code: 'MISSING_REQUIRED_FIELDS',
      details: { missing },
    });
  }

  if (fields.OddsAvailable === true) {
    const missingOdds = ODDS_REQUIRED_FIELDS.filter(name =>
      fields[name] === undefined || fields[name] === null || fields[name] === ''
    );
    if (missingOdds.length) {
      throw new SharePointPredictionError(
        `Při OddsAvailable=true chybí pole: ${missingOdds.join(', ')}.`,
        {
          status: 400,
          code: 'MISSING_ODDS_FIELDS',
          details: { missing: missingOdds },
        }
      );
    }
  }

  const matchTime = Date.parse(fields.MatchTime);
  const predictionTime = Date.parse(fields.PredictionTime);
  if (!Number.isFinite(matchTime) || !Number.isFinite(predictionTime)) {
    throw new SharePointPredictionError('MatchTime a PredictionTime musí být platné ISO datum/čas.', {
      status: 400,
      code: 'INVALID_DATETIME',
    });
  }

  if (fields.IsPreMatch === true && predictionTime >= matchTime) {
    throw new SharePointPredictionError('Předzápasová predikce musí mít PredictionTime < MatchTime.', {
      status: 400,
      code: 'NOT_PREMATCH',
    });
  }

  return fields;
}

export async function getGraphAccessToken() {
  const tenantId = requiredEnv('MS_TENANT_ID');
  const clientId = requiredEnv('MS_CLIENT_ID');
  const clientSecret = requiredEnv('MS_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  let response;
  try {
    response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      }
    );
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'MS_TOKEN_TIMEOUT'
      : 'MS_TOKEN_NETWORK_ERROR';
    throw new SharePointPredictionError('Microsoft Entra token request selhal.', {
      status: code === 'MS_TOKEN_TIMEOUT' ? 504 : 502,
      code,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new SharePointPredictionError(
      payload?.error_description || payload?.error || 'Nepodařilo se získat Microsoft Graph access token.',
      {
        status: 502,
        code: 'MS_TOKEN_ERROR',
        details: { token_status: response.status },
      }
    );
  }

  return payload.access_token;
}

async function findByIndexedField({ token, siteId, listId, fieldName, value }) {
  const url = new URL(graphItemsUrl(siteId, listId));
  url.searchParams.set('$select', 'id');
  url.searchParams.set(
    '$expand',
    `fields($select=PredictionId,SourceEventKey)`
  );
  url.searchParams.set(
    '$filter',
    `fields/${fieldName} eq '${escapeODataString(value)}'`
  );
  url.searchParams.set('$top', '1');

  const payload = await graphRequest(url, { token });
  return Array.isArray(payload?.value) && payload.value.length ? payload.value[0] : null;
}

export async function insertPredictionIfUnique(inputFields) {
  const fields = validatePredictionFields(inputFields);
  const siteId = requiredEnv('SHAREPOINT_SITE_ID');
  const listId = requiredEnv('SHAREPOINT_PREDICTIONS_LIST_ID');
  const token = await getGraphAccessToken();

  const duplicatePrediction = await findByIndexedField({
    token,
    siteId,
    listId,
    fieldName: 'PredictionId',
    value: fields.PredictionId,
  });

  if (duplicatePrediction) {
    return {
      created: false,
      duplicate: true,
      duplicate_field: 'PredictionId',
      item_id: duplicatePrediction.id,
      existing_prediction_id: duplicatePrediction?.fields?.PredictionId || fields.PredictionId,
      existing_source_event_key: duplicatePrediction?.fields?.SourceEventKey || null,
    };
  }

  const duplicateEvent = await findByIndexedField({
    token,
    siteId,
    listId,
    fieldName: 'SourceEventKey',
    value: fields.SourceEventKey,
  });

  if (duplicateEvent) {
    throw new SharePointPredictionError(
      'Pro tento SourceEventKey už v AI_Predictions existuje jiná predikce.',
      {
        status: 409,
        code: 'DUPLICATE_SOURCE_EVENT_KEY',
        details: {
          item_id: duplicateEvent.id,
          existing_prediction_id: duplicateEvent?.fields?.PredictionId || null,
          source_event_key: fields.SourceEventKey,
        },
      }
    );
  }

  let created;
  try {
    created = await graphRequest(graphItemsUrl(siteId, listId), {
      token,
      method: 'POST',
      body: { fields },
    });
  } catch (error) {
    if (error instanceof SharePointPredictionError && error.details?.graph_status === 409) {
      throw new SharePointPredictionError('SharePoint odmítl duplicitní hodnotu.', {
        status: 409,
        code: 'DUPLICATE_SHAREPOINT_VALUE',
      });
    }
    throw error;
  }

  return {
    created: true,
    duplicate: false,
    item_id: created?.id || null,
    web_url: created?.webUrl || null,
    fields: created?.fields || null,
  };
}
