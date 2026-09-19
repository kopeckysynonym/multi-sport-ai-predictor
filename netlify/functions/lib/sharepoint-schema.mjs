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

async function createColumnBatch(token, siteId, listId, definitions) {
  const requests = definitions.map((definition, index) => ({
    id: String(index + 1),
    method: 'POST',
    url: `/sites/${siteId}/lists/${listId}/columns`,
    headers: { 'Content-Type': 'application/json' },
    body: definition,
  }));

  const payload = await graphJson(
    'https://graph.microsoft.com/v1.0/$batch',
    {
      method: 'POST',
      body: JSON.stringify({ requests }),
    },
    token
  );

  const responses = Array.isArray(payload?.responses) ? payload.responses : [];
  const failures = [];
  const created = [];

  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const definition = definitions[index];
    if (Number(response?.status) >= 200 && Number(response?.status) < 300) {
      created.push(definition.name);
    } else {
      failures.push({
        name: definition.name,
        status: response?.status || null,
        error: response?.body?.error?.message || response?.body?.error?.code || 'Unknown Graph batch error',
      });
    }
  }

  return { created, failures };
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

  for (let offset = 0; offset < missing.length; offset += 20) {
    const batch = missing.slice(offset, offset + 20);
    const result = await createColumnBatch(token, siteId, listId, batch);
    created.push(...result.created);
    failures.push(...result.failures);
  }

  const after = await listPredictionColumns();
  const afterNames = new Set(after.map(column => column?.name).filter(Boolean));
  const stillMissing = AI_PREDICTIONS_COLUMNS
    .map(column => column.name)
    .filter(name => !afterNames.has(name));

  return {
    requested: AI_PREDICTIONS_COLUMNS.length,
    already_present: AI_PREDICTIONS_COLUMNS.length - missing.length,
    created: created.length,
    created_columns: created,
    failures,
    still_missing: stillMissing,
    ready: stillMissing.length === 0,
  };
}
