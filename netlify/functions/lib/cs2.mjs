import { ProviderError, fetchJson } from './http.mjs';

const BASE = 'https://api.oddspapi.io/v4';
const CS2_SPORT_ID = 17;
const CS2_WINNER_MARKET_ID = '171';
const CS2_HOME_OUTCOME_ID = '171';
const CS2_AWAY_OUTCOME_ID = '172';
const cache = new Map();
const lastRequestAt = new Map();

function env(name) {
  try {
    return globalThis.Netlify?.env?.get?.(name) || process.env[name] || null;
  } catch {
    return process.env[name] || null;
  }
}

function apiKey() {
  const value = env('ODDSPAPI_API_KEY');
  if (!value) {
    throw new ProviderError(
      'Chybí ODDSPAPI_API_KEY v Netlify environment variables.',
      { status: 503, code: 'MISSING_ODDSPAPI_KEY' }
    );
  }
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function endpointCooldown(path) {
  if (path === 'fixtures') return 2100;
  if (path === 'scores' || path === 'fixture' || path === 'markets') return 1100;
  if (path === 'settlements') return 2100;
  return 600;
}

async function pace(path) {
  const cooldown = endpointCooldown(path);
  const last = lastRequestAt.get(path) || 0;
  const wait = cooldown - (Date.now() - last);
  if (wait > 0) await sleep(wait);
}

async function request(path, params = {}) {
  const call = async () => {
    await pace(path);
    const url = new URL(BASE + '/' + String(path).replace(/^\//, ''));
    url.searchParams.set('apiKey', apiKey());
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(name, String(value));
      }
    }
    try {
      const { data } = await fetchJson(url, { headers: { accept: 'application/json' } }, 'OddsPapi');
      return data;
    } finally {
      lastRequestAt.set(path, Date.now());
    }
  };

  try {
    return await call();
  } catch (error) {
    if (error?.code !== 'HTTP_429') throw error;
    await sleep(Math.max(2500, endpointCooldown(path)));
    return call();
  }
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

function dateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function shiftDate(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function fixtureTime(row) {
  return Date.parse(row?.trueStartTime || row?.startTime || '');
}

function completedFixture(row, targetMs) {
  const time = fixtureTime(row);
  const status = String(row?.statusName || '').toLowerCase();
  return Number.isFinite(time) &&
    time < targetMs &&
    (Number(row?.statusId) === 2 || status.includes('finish') || status.includes('ended'));
}

function aggregateScore(payload) {
  const row = payload?.scores?.['0'] ?? payload?.scores?.[0] ?? null;
  const home = Number(row?.participant1Score);
  const away = Number(row?.participant2Score);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away };
}

export function cs2RecentFormProbability(teamA, teamB) {
  const aMatches = Number(teamA?.matches_used) || 0;
  const bMatches = Number(teamB?.matches_used) || 0;
  if (aMatches < 1 || bMatches < 1) throw new TypeError('Chybí CS2 recent-form data.');

  const smooth = team => {
    const wins = Number(team?.wins) || 0;
    return Math.max(0.08, Math.min(0.92, (wins + 1.5) / ((Number(team?.matches_used) || 0) + 3)));
  };
  const logit = p => Math.log(p / (1 - p));
  const logistic = x => 1 / (1 + Math.exp(-x));

  const pA = smooth(teamA);
  const pB = smooth(teamB);
  const mapDiffA = Number(teamA?.map_diff_avg) || 0;
  const mapDiffB = Number(teamB?.map_diff_avg) || 0;
  const score = 0.70 * (logit(pA) - logit(pB)) + 0.18 * (mapDiffA - mapDiffB);
  return Math.max(0.12, Math.min(0.88, logistic(score)));
}

export async function listCs2Upcoming() {
  const cacheKey = 'cs2:upcoming:oddspapi';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const from = dateOnly(now);
  const to = dateOnly(shiftDate(now, 9));
  const payload = await request('fixtures', {
    sportId: CS2_SPORT_ID,
    from,
    to,
    statusId: 0,
    language: 'en',
  });

  const nowMs = Date.now();
  const events = (Array.isArray(payload) ? payload : [])
    .filter(row => fixtureTime(row) >= nowMs)
    .filter(row => row?.fixtureId && row?.participant1Id && row?.participant2Id)
    .filter(row => row?.participant1Name && row?.participant2Name)
    .map(row => ({
      id: String(row.fixtureId),
      event_id: String(row.fixtureId),
      fixture_id: String(row.fixtureId),
      provider: 'oddspapi',
      sport_key: 'oddspapi_cs2',
      commence_time: row.startTime,
      home_team: row.participant1Name,
      away_team: row.participant2Name,
      team_a_id: String(row.participant1Id),
      team_b_id: String(row.participant2Id),
      league: row.tournamentName || 'CS2',
      country: row.categoryName || null,
      venue: null,
      format: null,
      has_odds: Boolean(row.hasOdds),
      analysis_available: true,
      data_status: 'PŘIPRAVENO',
    }))
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))
    .slice(0, 30);

  return cacheSet(cacheKey, events, 5 * 60 * 1000);
}

async function recentFixturesForTeam(teamId, targetDate, wanted = 5) {
  const target = new Date(targetDate || Date.now());
  const targetMs = target.getTime();
  if (!Number.isFinite(targetMs)) {
    throw new ProviderError('Neplatné datum CS2 zápasu.', { status: 422, code: 'CS2_INVALID_DATE' });
  }

  const cacheKey = `cs2:fixtures:${teamId}:${target.toISOString().slice(0, 10)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const payload = await request('fixtures', {
    participantId: teamId,
    from: dateOnly(shiftDate(target, -120)),
    to: dateOnly(target),
    statusId: 2,
    language: 'en',
  });

  const rows = (Array.isArray(payload) ? payload : [])
    .filter(row => completedFixture(row, targetMs))
    .filter(row =>
      String(row?.participant1Id || '') === String(teamId) ||
      String(row?.participant2Id || '') === String(teamId)
    )
    .sort((a, b) => fixtureTime(b) - fixtureTime(a))
    .slice(0, wanted);

  return cacheSet(cacheKey, rows, 6 * 60 * 60 * 1000);
}

async function scoreForFixture(fixtureId) {
  const cacheKey = 'cs2:score:' + fixtureId;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const payload = await request('scores', { fixtureId });
  const score = aggregateScore(payload);
  return cacheSet(cacheKey, score, 24 * 60 * 60 * 1000);
}

function summarizeTeamForm(teamId, fixtures, scoresById) {
  const games = [];
  for (const fixture of fixtures) {
    const score = scoresById.get(String(fixture.fixtureId));
    if (!score) continue;

    const isParticipant1 = String(fixture.participant1Id) === String(teamId);
    const own = isParticipant1 ? score.home : score.away;
    const opp = isParticipant1 ? score.away : score.home;
    if (!Number.isFinite(own) || !Number.isFinite(opp) || own === opp) continue;

    games.push({
      fixture_id: String(fixture.fixtureId),
      date: fixture.trueEndTime || fixture.trueStartTime || fixture.startTime,
      won: own > opp,
      maps_for: own,
      maps_against: opp,
      map_diff: own - opp,
    });
  }

  if (!games.length) {
    return {
      matches_used: 0,
      wins: 0,
      losses: 0,
      win_pct: null,
      map_diff_avg: null,
      last_match_date: null,
      range: null,
    };
  }

  const wins = games.filter(game => game.won).length;
  const times = games
    .map(game => ({ value: game.date, time: Date.parse(game.date || '') }))
    .filter(row => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);

  return {
    matches_used: games.length,
    wins,
    losses: games.length - wins,
    win_pct: Number((100 * wins / games.length).toFixed(1)),
    map_diff_avg: Number((games.reduce((sum, game) => sum + game.map_diff, 0) / games.length).toFixed(2)),
    last_match_date: times.at(-1)?.value || null,
    range: times.length ? { from: times[0].value, to: times.at(-1).value } : null,
  };
}

export function summarizeCs2MarketOdds(payload) {
  const books = payload?.bookmakerOdds || {};
  const candidates = [];

  for (const [bookmaker, book] of Object.entries(books)) {
    if (book?.suspended === true || book?.bookmakerIsActive === false) continue;
    const market = book?.markets?.[CS2_WINNER_MARKET_ID];
    if (!market || market?.marketActive === false) continue;

    const homePlayer = market?.outcomes?.[CS2_HOME_OUTCOME_ID]?.players?.['0'];
    const awayPlayer = market?.outcomes?.[CS2_AWAY_OUTCOME_ID]?.players?.['0'];
    const home = Number(homePlayer?.price);
    const away = Number(awayPlayer?.price);
    if (!(home > 1) || !(away > 1)) continue;
    if (homePlayer?.active === false || awayPlayer?.active === false) continue;

    candidates.push({
      home,
      away,
      bookmaker,
      bookmaker_path: book?.fixturePath || null,
      captured_at: [homePlayer?.changedAt, awayPlayer?.changedAt].filter(Boolean).sort().at(-1) || null,
      margin: (1 / home) + (1 / away),
    });
  }

  if (!candidates.length) return null;

  const preferred = String(env('ODDSPAPI_CS2_BOOKMAKERS') || 'pinnacle,bet365,1xbet')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  candidates.sort((a, b) => {
    const rankA = preferred.indexOf(a.bookmaker.toLowerCase());
    const rankB = preferred.indexOf(b.bookmaker.toLowerCase());
    const prefA = rankA === -1 ? 999 : rankA;
    const prefB = rankB === -1 ? 999 : rankB;
    return prefA - prefB || a.margin - b.margin;
  });

  const selected = candidates[0];
  return {
    home: selected.home,
    away: selected.away,
    bookmaker: selected.bookmaker,
    bookmaker_path: selected.bookmaker_path,
    captured_at: selected.captured_at,
    market_id: Number(CS2_WINNER_MARKET_ID),
    book_count: candidates.length,
    source: 'oddspapi',
  };
}

export async function loadCs2MarketOdds(fixtureId) {
  if (!fixtureId) return null;
  const cacheKey = 'cs2:odds:' + fixtureId;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const bookmakers = String(env('ODDSPAPI_CS2_BOOKMAKERS') || 'pinnacle,bet365,1xbet')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(',');

  const payload = await request('odds', {
    fixtureId,
    bookmakers,
    oddsFormat: 'decimal',
    language: 'en',
    verbosity: 3,
  });

  return cacheSet(cacheKey, summarizeCs2MarketOdds(payload), 2 * 60 * 1000);
}

export async function loadCs2PredictionData(selectedFixture) {
  const teamAId = selectedFixture?.team_a_id;
  const teamBId = selectedFixture?.team_b_id;
  const fixtureId = selectedFixture?.event_id || selectedFixture?.fixture_id;
  const targetDate = selectedFixture?.commence_time;

  if (!fixtureId || !teamAId || !teamBId || !targetDate) {
    throw new ProviderError(
      'CS2 predikce vyžaduje konkrétní OddsPapi zápas s participant id.',
      { status: 422, code: 'CS2_FIXTURE_REQUIRED' }
    );
  }

  const fixturesA = await recentFixturesForTeam(teamAId, targetDate, 5);
  const fixturesB = await recentFixturesForTeam(teamBId, targetDate, 5);
  const unique = new Map(
    [...fixturesA, ...fixturesB]
      .filter(row => row?.fixtureId)
      .map(row => [String(row.fixtureId), row])
  );

  const scoresById = new Map();
  for (const id of unique.keys()) {
    const score = await scoreForFixture(id);
    if (score) scoresById.set(id, score);
  }

  const teamA = summarizeTeamForm(teamAId, fixturesA, scoresById);
  const teamB = summarizeTeamForm(teamBId, fixturesB, scoresById);

  if (teamA.matches_used < 3 || teamB.matches_used < 3) {
    throw new ProviderError(
      `Pro CS2 model jsou potřeba alespoň 3 dokončené série u obou týmů. ${selectedFixture.home_team}: ${teamA.matches_used}, ${selectedFixture.away_team}: ${teamB.matches_used}.`,
      { status: 422, code: 'CS2_NOT_ENOUGH_HISTORY' }
    );
  }

  const probabilityA = cs2RecentFormProbability(teamA, teamB);
  const marketOdds = await loadCs2MarketOdds(fixtureId);

  const targetMs = Date.parse(targetDate);
  const newestTimes = [teamA.last_match_date, teamB.last_match_date]
    .map(value => Date.parse(value || ''))
    .filter(Number.isFinite);
  const newest = newestTimes.length ? Math.max(...newestTimes) : null;
  const dataAgeDays = newest && Number.isFinite(targetMs)
    ? Math.max(0, Math.round((targetMs - newest) / 86400000))
    : null;
  const limitedReliability =
    teamA.matches_used < 5 ||
    teamB.matches_used < 5 ||
    (Number.isFinite(dataAgeDays) && dataAgeDays > 60);

  const ranges = [teamA.range, teamB.range].filter(Boolean);
  const rangeTimes = ranges
    .flatMap(range => [range.from, range.to])
    .map(value => ({ value, time: Date.parse(value || '') }))
    .filter(row => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);

  return {
    team_a: teamA,
    team_b: teamB,
    series_probability_a: probabilityA,
    market_odds: marketOdds,
    limited_reliability: limitedReliability,
    data_age_days: dataAgeDays,
    historical_match_range: rangeTimes.length
      ? { from: rangeTimes[0].value, to: rangeTimes.at(-1).value }
      : null,
  };
}

export async function getCs2CompletedScore(fixtureId) {
  if (!fixtureId) return null;

  const fixture = await request('fixture', { fixtureId, language: 'en' });
  const status = String(fixture?.statusName || '').toLowerCase();
  if (!(Number(fixture?.statusId) === 2 || status.includes('finish') || status.includes('ended'))) {
    return null;
  }

  const payload = await request('scores', { fixtureId });
  return aggregateScore(payload);
}
