import { ProviderError, fetchJson } from './http.mjs';

const BASE = (globalThis.Netlify?.env?.get?.('ESPORTSODDS_BASE') || process.env.ESPORTSODDS_BASE || 'https://api.esportsodds.gg').replace(/\/$/, '');
const cache = new Map();

function env(name) {
  try {
    return globalThis.Netlify?.env?.get?.(name) || process.env[name] || null;
  } catch {
    return process.env[name] || null;
  }
}

function key() {
  const value = env('ESPORTSODDS_API_KEY');
  if (!value) {
    throw new ProviderError(
      'Chybí ESPORTSODDS_API_KEY v Netlify environment variables.',
      { status: 503, code: 'MISSING_ESPORTSODDS_KEY' }
    );
  }
  return value;
}

function cacheGet(name) {
  const row = cache.get(name);
  if (!row || row.expires <= Date.now()) {
    cache.delete(name);
    return null;
  }
  return row.value;
}

function cacheSet(name, value, ttlMs) {
  cache.set(name, { value, expires: Date.now() + ttlMs });
  return value;
}

function isoDateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function request(path, params = {}) {
  const url = new URL(BASE + '/v1/cs2/' + String(path).replace(/^\//, ''));
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  const { data } = await fetchJson(
    url,
    { headers: { Authorization: 'Bearer ' + key(), accept: 'application/json' } },
    'EsportsOdds'
  );
  return data;
}

export async function listCs2Upcoming() {
  const cacheKey = 'cs2:upcoming';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const payload = await request('matches', {
    status: 'scheduled',
    date_from: isoDateOffset(0),
    date_to: isoDateOffset(14),
    limit: 50,
  });

  const now = Date.now();
  const events = (payload?.data || [])
    .filter(row => Date.parse(row?.scheduled_at || '') >= now)
    .filter(row => row?.team_a_id && row?.team_b_id && row?.team_a_name && row?.team_b_name)
    .map(row => ({
      id: String(row.id),
      event_id: String(row.id),
      fixture_id: null,
      provider: 'esportsodds',
      sport_key: 'esports_cs2',
      commence_time: row.scheduled_at,
      home_team: row.team_a_name,
      away_team: row.team_b_name,
      team_a_id: String(row.team_a_id),
      team_b_id: String(row.team_b_id),
      league: row.tournament_name || 'CS2',
      country: null,
      venue: null,
      format: row.format || null,
      stage: row.stage || null,
      analysis_available: true,
      data_status: 'PŘIPRAVENO',
    }))
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))
    .slice(0, 30);

  return cacheSet(cacheKey, events, 10 * 60 * 1000);
}

export async function loadCs2TeamRating(teamId) {
  if (!teamId) {
    throw new ProviderError('CS2 zápas nemá team id.', { status: 422, code: 'CS2_TEAM_ID_MISSING' });
  }

  const cacheKey = 'cs2:rating:' + teamId;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const payload = await request('teams/' + encodeURIComponent(teamId) + '/ratings', { limit: 30 });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!rows.length) {
    throw new ProviderError(
      'EsportsOdds nemá ratingovou historii pro CS2 tým ' + teamId + '.',
      { status: 422, code: 'CS2_RATING_UNAVAILABLE' }
    );
  }

  const valid = rows.filter(row => Number.isFinite(Number(row?.rating)) && Number.isFinite(Number(row?.rd)));
  if (!valid.length) {
    throw new ProviderError(
      'EsportsOdds vrátil neúplný Glicko-2 rating.',
      { status: 422, code: 'CS2_RATING_INCOMPLETE' }
    );
  }

  const latest = valid[valid.length - 1];
  const first = valid[0];
  const result = {
    rating: Number(latest.rating),
    rd: Number(latest.rd),
    conservative_rating: Number(latest.rating) - 2 * Number(latest.rd),
    points_used: valid.length,
    range: {
      from: first?.as_of || null,
      to: latest?.as_of || null,
    },
  };
  return cacheSet(cacheKey, result, 30 * 60 * 1000);
}

function combination(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = result * (n - k + i) / i;
  return result;
}

export function cs2SeriesProbability(mapProbability, format = 'bo3') {
  const p = Math.max(0.02, Math.min(0.98, Number(mapProbability)));
  const match = String(format || '').toLowerCase().match(/bo(\d+)/);
  const maps = match ? Number(match[1]) : 3;
  const bestOf = [1, 3, 5].includes(maps) ? maps : 3;
  const needed = Math.floor(bestOf / 2) + 1;
  let probability = 0;
  for (let wins = needed; wins <= bestOf; wins += 1) {
    probability += combination(bestOf, wins) * (p ** wins) * ((1 - p) ** (bestOf - wins));
  }
  return probability;
}

export function cs2ModelProbability(teamA, teamB, format = 'bo3') {
  const a = Number(teamA?.conservative_rating);
  const b = Number(teamB?.conservative_rating);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Chybí CS2 conservative rating.');
  }
  const mapProbability = 1 / (1 + (10 ** ((b - a) / 400)));
  return {
    map_probability_a: mapProbability,
    series_probability_a: cs2SeriesProbability(mapProbability, format),
  };
}

export function summarizeCs2MarketOdds(rows = [], teamAId = null, teamBId = null) {
  const relevant = rows
    .filter(row => row?.source === 'eo_market')
    .filter(row => row?.market_type === 'match_winner')
    .filter(row => row?.map_number == null)
    .filter(row => row?.in_play !== true)
    .filter(row => ['home', 'away'].includes(String(row?.outcome_key || '').toLowerCase()))
    .filter(row => Number(row?.price) > 1)
    .sort((a, b) => Date.parse(b?.captured_at || 0) - Date.parse(a?.captured_at || 0));

  const latest = {};
  for (const row of relevant) {
    const participant = String(row?.participant_id || '');
    let side = null;
    if (teamAId && participant === String(teamAId)) side = 'home';
    else if (teamBId && participant === String(teamBId)) side = 'away';
    else side = String(row.outcome_key).toLowerCase();
    if (['home', 'away'].includes(side) && !latest[side]) latest[side] = row;
  }

  if (!latest.home || !latest.away) return null;
  return {
    home: Number(latest.home.price),
    away: Number(latest.away.price),
    captured_at: [latest.home.captured_at, latest.away.captured_at].filter(Boolean).sort().at(-1) || null,
    book_count: Math.min(
      Number(latest.home.book_count) || 0,
      Number(latest.away.book_count) || 0
    ) || null,
    source: 'eo_market',
  };
}

export async function loadCs2MarketOdds(matchId, teamAId = null, teamBId = null) {
  if (!matchId) return null;
  const cacheKey = 'cs2:odds:' + matchId;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const payload = await request('odds', {
    match: matchId,
    source: 'eo_market',
    limit: 200,
  });
  const result = summarizeCs2MarketOdds(payload?.data || [], teamAId, teamBId);
  return cacheSet(cacheKey, result, 2 * 60 * 1000);
}

export async function loadCs2PredictionData(selectedFixture) {
  const teamAId = selectedFixture?.team_a_id;
  const teamBId = selectedFixture?.team_b_id;
  if (!selectedFixture?.event_id || !teamAId || !teamBId) {
    throw new ProviderError(
      'CS2 predikce vyžaduje konkrétní EsportsOdds zápas s team id.',
      { status: 422, code: 'CS2_FIXTURE_REQUIRED' }
    );
  }

  const [teamA, teamB, marketOdds] = await Promise.all([
    loadCs2TeamRating(teamAId),
    loadCs2TeamRating(teamBId),
    loadCs2MarketOdds(selectedFixture.event_id, teamAId, teamBId),
  ]);

  const model = cs2ModelProbability(teamA, teamB, selectedFixture.format || 'bo3');
  const limitedReliability =
    teamA.points_used < 5 ||
    teamB.points_used < 5 ||
    teamA.rd > 125 ||
    teamB.rd > 125;

  const times = [
    teamA.range?.from,
    teamA.range?.to,
    teamB.range?.from,
    teamB.range?.to,
  ]
    .filter(Boolean)
    .map(value => ({ value, time: Date.parse(value) }))
    .filter(row => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);

  return {
    team_a: teamA,
    team_b: teamB,
    map_probability_a: model.map_probability_a,
    series_probability_a: model.series_probability_a,
    market_odds: marketOdds,
    limited_reliability: limitedReliability,
    historical_match_range: times.length
      ? { from: times[0].value, to: times[times.length - 1].value }
      : null,
  };
}

export async function getCs2CompletedScore(matchId) {
  if (!matchId) return null;
  const payload = await request('matches/' + encodeURIComponent(matchId));
  const match = payload?.data;
  if (!match || String(match.status).toLowerCase() !== 'completed') return null;
  const a = Number(match.score_a);
  const b = Number(match.score_b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return {
    home: a,
    away: b,
    winner_team_id: match.winner_team_id || null,
    result_type: match.result_type || null,
  };
}
