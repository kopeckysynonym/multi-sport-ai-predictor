import { SharePointPredictionError, getGraphAccessToken } from './sharepoint.mjs';

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

const text = (name, displayName, options = {}) => ({
  name,
  displayName,
  required: Boolean(options.required),
  indexed: Boolean(options.indexed),
  enforceUniqueValues: Boolean(options.unique),
  text: {
    allowMultipleLines: Boolean(options.multiline),
    appendChangesToExistingText: false,
    linesForEditing: options.multiline ? 6 : 0,
    maxLength: options.multiline ? 0 : 255,
    textType: 'plain',
  },
});

const number = (name, displayName, options = {}) => ({
  name,
  displayName,
  required: Boolean(options.required),
  indexed: Boolean(options.indexed),
  number: {},
});

const bool = (name, displayName, options = {}) => ({
  name,
  displayName,
  required: Boolean(options.required),
  boolean: {},
});

const dateTime = (name, displayName, options = {}) => ({
  name,
  displayName,
  required: Boolean(options.required),
  indexed: Boolean(options.indexed),
  dateTime: {
    displayAs: 'default',
    format: 'dateTime',
  },
});

const choice = (name, displayName, choices, options = {}) => ({
  name,
  displayName,
  required: Boolean(options.required),
  indexed: Boolean(options.indexed),
  choice: {
    allowTextEntry: false,
    choices,
    displayAs: 'dropDown',
  },
});

export const AI_PREDICTIONS_COLUMNS = [
  text('PredictionId', 'Prediction ID', { required: true, indexed: true, unique: true }),
  number('SchemaVersion', 'Schema verze', { required: true }),
  text('SourceEventKey', 'Source Event Key', { required: true, indexed: true, unique: true }),
  text('EventId', 'Event ID'),
  text('FixtureId', 'Fixture ID'),
  text('SportKey', 'Sport key'),
  choice('Sport', 'Sport', ['cz_football', 'fifa', 'nba', 'nhl', 'tennis'], { required: true, indexed: true }),
  text('SportLabel', 'Sport label', { required: true }),
  text('Competition', 'Soutěž / turnaj'),
  text('TeamA', 'Tým / hráč A', { required: true }),
  text('TeamB', 'Tým / hráč B', { required: true }),
  dateTime('MatchTime', 'Datum zápasu', { required: true, indexed: true }),
  dateTime('PredictionTime', 'Čas predikce', { required: true, indexed: true }),
  bool('IsPreMatch', 'Předzápasová predikce', { required: true }),
  text('ModelName', 'Model', { required: true }),
  text('ModelVersion', 'Verze modelu', { required: true, indexed: true }),
  text('DataMode', 'Datový režim', { required: true }),
  choice('Reliability', 'Spolehlivost', ['STANDARD', 'LIMITED', 'INSUFFICIENT', 'UNKNOWN'], { required: true, indexed: true }),
  bool('LimitedReliability', 'Omezená spolehlivost', { required: true }),
  number('DataSampleA', 'Počet dat A'),
  number('DataSampleB', 'Počet dat B'),
  dateTime('HistoricalFrom', 'Historická data od'),
  dateTime('HistoricalTo', 'Historická data do'),
  dateTime('RollingFrom', 'Rolling okno od'),
  dateTime('RollingTo', 'Rolling okno do'),
  dateTime('LatestDataDate', 'Nejnovější dostupná data'),
  number('DataAgeDays', 'Stáří dat – dny'),
  bool('OddsAvailable', 'Kurzy dostupné', { required: true }),
  text('OddsSource', 'Zdroj kurzů'),
  dateTime('OddsSnapshotTime', 'Čas kurzu'),
  text('Bookmaker', 'Bookmaker / consensus'),
  choice('Market', 'Trh', ['home', 'away', 'draw', 'home_moneyline', 'away_moneyline', 'home_cover', 'away_cover']),
  text('Selection', 'Výběr'),
  number('TrackedOdds', 'Kurz'),
  number('ModelProbabilityPct', 'Modelová pravděpodobnost %', { required: true }),
  number('RawImpliedProbabilityPct', 'Raw implied probability %'),
  number('MarketProbabilityPct', 'Tržní pravděpodobnost %'),
  number('MarketOverroundPct', 'Market overround %'),
  number('EdgePctPoints', 'Edge p. b.'),
  number('ExpectedRoiPct', 'Expected ROI %'),
  text('PredictedWinner', 'Predikovaný vítěz'),
  number('PredictedScoreA', 'Predikované skóre A'),
  number('PredictedScoreB', 'Predikované skóre B'),
  bool('RecommendationAllowed', 'Doporučení povoleno', { required: true }),
  choice('Recommendation', 'Doporučení', ['BET', 'NO_BET', 'NO_RECOMMENDATION'], { required: true }),
  choice('SettlementStatus', 'Stav vyhodnocení', ['PENDING', 'SETTLED', 'VOID', 'ERROR'], { required: true, indexed: true }),
  number('ActualScoreA', 'Skutečné skóre A'),
  number('ActualScoreB', 'Skutečné skóre B'),
  choice('ActualResult', 'Skutečný výsledek', ['A', 'B', 'DRAW', 'VOID']),
  text('ActualWinner', 'Skutečný vítěz'),
  choice('BetOutcome', 'Výsledek simulované sázky', ['WIN', 'LOSS', 'PUSH', 'VOID']),
  number('StakeUnits', 'Simulovaný vklad', { required: true }),
  number('ProfitUnits', 'Simulovaný P/L'),
  number('ReturnUnits', 'Simulovaná návratnost'),
  dateTime('SettledAt', 'Čas vyhodnocení'),
  text('ResultSource', 'Zdroj výsledku'),
  number('ClosingOdds', 'Closing kurz'),
  dateTime('ClosingOddsTime', 'Čas closing kurzu'),
  number('ClvPct', 'CLV %'),
  text('MetadataJson', 'Metadata JSON', { multiline: true }),
];

async function graphJson(url, options, token) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options?.body ? { 'content-type': 'application/json' } : {}),
      ...(options?.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SharePointPredictionError(
      payload?.error?.message || `Microsoft Graph HTTP ${response.status}.`,
      {
        status: 502,
        code: payload?.error?.code || `GRAPH_HTTP_${response.status}`,
        details: { graph_status: response.status },
      }
    );
  }
  return payload;
}

export async function listPredictionColumns() {
  const siteId = requiredEnv('SHAREPOINT_SITE_ID');
  const listId = requiredEnv('SHAREPOINT_PREDICTIONS_LIST_ID');
  const token = await getGraphAccessToken();
  const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/columns?$select=id,name,displayName,hidden,readOnly`;
  const payload = await graphJson(url, { method: 'GET' }, token);
  return Array.isArray(payload?.value) ? payload.value : [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function creationDefinition(definition) {
  const {
    required: _required,
    indexed: _indexed,
    enforceUniqueValues: _unique,
    ...base
  } = definition;
  return {
    ...base,
    hidden: false,
    indexed: false,
    enforceUniqueValues: false,
  };
}

function desiredColumnSettings(definition) {
  const settings = {};
  if (definition.required === true) settings.required = true;
  if (definition.indexed === true) settings.indexed = true;
  if (definition.enforceUniqueValues === true) settings.enforceUniqueValues = true;
  return settings;
}

async function graphWrite(url, { method = 'POST', body }, token) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    payload,
    retryAfter: Number(response.headers.get('retry-after')) || 0,
  };
}

async function createColumnSequential(token, siteId, listId, definition) {
  const baseUrl = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/columns`;
  const body = creationDefinition(definition);

  let last = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    last = await graphWrite(baseUrl, { method: 'POST', body }, token);
    if (last.ok) break;

    const retryable = [409, 429, 500, 502, 503, 504].includes(last.status);
    if (!retryable || attempt === 5) break;

    const waitMs = last.retryAfter > 0
      ? Math.min(last.retryAfter * 1000, 4000)
      : Math.min(250 * (2 ** (attempt - 1)), 2000);
    await sleep(waitMs);
  }

  if (!last?.ok) {
    return {
      created: false,
      configured: false,
      name: definition.name,
      status: last?.status || null,
      error: last?.payload?.error?.message || last?.payload?.error?.code || 'Unknown Graph error',
    };
  }

  const columnId = last.payload?.id;
  const settings = desiredColumnSettings(definition);
  if (!columnId || Object.keys(settings).length === 0) {
    return {
      created: true,
      configured: Object.keys(settings).length === 0,
      name: definition.name,
      status: last.status,
      settings_status: Object.keys(settings).length === 0 ? 'not_needed' : 'missing_column_id',
    };
  }

  let patched = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    patched = await graphWrite(
      `${baseUrl}/${encodeURIComponent(columnId)}`,
      { method: 'PATCH', body: settings },
      token
    );
    if (patched.ok) break;

    const retryable = [409, 429, 500, 502, 503, 504].includes(patched.status);
    if (!retryable || attempt === 4) break;
    await sleep(Math.min(300 * (2 ** (attempt - 1)), 2000));
  }

  return {
    created: true,
    configured: Boolean(patched?.ok),
    name: definition.name,
    status: last.status,
    settings_status: patched?.status || null,
    settings_error: patched?.ok
      ? null
      : patched?.payload?.error?.message || patched?.payload?.error?.code || 'Column created, settings update failed',
  };
}

export async function provisionAiPredictionsSchema() {
  const siteId = requiredEnv('SHAREPOINT_SITE_ID');
  const listId = requiredEnv('SHAREPOINT_PREDICTIONS_LIST_ID');
  const token = await getGraphAccessToken();

  const existing = await listPredictionColumns();
  const existingNames = new Set(existing.map(column => column?.name).filter(Boolean));
  const missing = AI_PREDICTIONS_COLUMNS.filter(column => !existingNames.has(column.name));

  const created = [];
  const failures = [];
  const configurationWarnings = [];

  for (const definition of missing) {
    const result = await createColumnSequential(token, siteId, listId, definition);
    if (result.created) {
      created.push(definition.name);
      if (!result.configured && result.settings_status !== 'not_needed') {
        configurationWarnings.push({
          name: definition.name,
          status: result.settings_status,
          error: result.settings_error,
        });
      }
      await sleep(120);
    } else {
      failures.push({
        name: definition.name,
        status: result.status,
        error: result.error,
      });
      await sleep(250);
    }
  }

  await sleep(500);
  const after = await listPredictionColumns();
  const afterNames = new Set(after.map(column => column?.name).filter(Boolean));
  for (const name of created) afterNames.add(name);

  const stillMissing = AI_PREDICTIONS_COLUMNS
    .map(column => column.name)
    .filter(name => !afterNames.has(name));

  return {
    requested: AI_PREDICTIONS_COLUMNS.length,
    already_present: AI_PREDICTIONS_COLUMNS.length - missing.length,
    created: created.length,
    created_columns: created,
    failures,
    configuration_warnings: configurationWarnings,
    still_missing: stillMissing,
    ready: stillMissing.length === 0,
  };
}
