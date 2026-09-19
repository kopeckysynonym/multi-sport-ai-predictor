import { ProviderError } from './http.mjs';

const TENNIS_CACHE = new Map();
const RAW_BASES = {
  atp: [
    year => `https://raw.githubusercontent.com/Kadantte/tennis_atp/master/atp_matches_${year}.csv`,
    year => `https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/atp/atp_matches_${year}.csv`
  ],
  wta: [
    year => `https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_${year}.csv`,
    year => `https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/wta/wta_matches_${year}.csv`
  ]
};

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(value);
      value = '';
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

function parseTourneyDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T12:00:00Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseMatchCsv(text, tour) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(headers.map((name, i) => [name, i]));
  const get = (row, key) => row[idx[key]] ?? '';

  const matches = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const date = parseTourneyDate(get(row, 'tourney_date'));
    const winner = get(row, 'winner_name').trim();
    const loser = get(row, 'loser_name').trim();
    if (!date || !winner || !loser) continue;
    matches.push({
      tour,
      date,
      tournament: get(row, 'tourney_name').trim() || null,
      surface: normalizeSurface(get(row, 'surface')),
      winner,
      loser,
      winner_rank: Number(get(row, 'winner_rank')) || null,
      loser_rank: Number(get(row, 'loser_rank')) || null
    });
  }
  return matches;
}

async function fetchText(url, label) {
  const response = await fetch(url, {
    headers: { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) {
    const error = new Error(`${label}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function fetchTennisYear(tour, year) {
  const cacheKey = `year:${tour}:${year}`;
  const cached = TENNIS_CACHE.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const loaders = RAW_BASES[tour] || [];
  let lastError = null;
  for (const urlForYear of loaders) {
    const url = urlForYear(year);
    try {
      const text = await fetchText(url, `${tour.toUpperCase()} tennis data`);
      const value = {
        matches: parseMatchCsv(text, tour),
        source_url: url
      };
      TENNIS_CACHE.set(cacheKey, { value, expires: Date.now() + 60 * 60 * 1000 });
      return value;
    } catch (error) {
      lastError = error;
    }
  }

  throw new ProviderError(
    `Nepodařilo se načíst ${tour.toUpperCase()} historická data pro rok ${year}: ${lastError?.message || 'zdroj není dostupný'}.`,
    { status: 502, code: 'TENNIS_HISTORY_UNAVAILABLE' }
  );
}

export function tennisTourFromSportKey(sportKey) {
  const key = String(sportKey || '').toLowerCase();
  if (key.startsWith('tennis_atp_')) return 'atp';
  if (key.startsWith('tennis_wta_')) return 'wta';
  return null;
}

export function normalizeSurface(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('clay')) return 'Clay';
  if (text.includes('grass')) return 'Grass';
  if (text.includes('carpet')) return 'Carpet';
  return 'Hard';
}

export function tennisSurfaceFromSportKey(sportKey, title = '') {
  const text = `${sportKey || ''} ${title || ''}`.toLowerCase();
  if (/(french|roland|clay|monte[_ -]?carlo|madrid|italian|rome|barcelona|munich|hamburg|charleston|stuttgart)/.test(text)) {
    return 'Clay';
  }
  if (/(wimbledon|halle|queen|queens|bad[_ -]?homburg|grass)/.test(text)) {
    return 'Grass';
  }
  return 'Hard';
}

function yearsForRollingWindow(targetDate) {
  const target = new Date(targetDate || Date.now());
  const from = new Date(target.getTime() - 365 * 86400000);
  return [...new Set([from.getUTCFullYear(), target.getUTCFullYear()])];
}

export async function loadTennisRollingMatches(tour, targetDate) {
  if (!['atp', 'wta'].includes(tour)) {
    throw new ProviderError('Neznámý tenisový okruh.', { status: 400, code: 'TENNIS_TOUR_UNKNOWN' });
  }

  const target = new Date(targetDate || Date.now());
  if (Number.isNaN(target.getTime())) {
    throw new ProviderError('Neplatné datum tenisového utkání.', { status: 400, code: 'TENNIS_DATE_INVALID' });
  }

  const years = yearsForRollingWindow(target.toISOString());
  const payloads = await Promise.all(years.map(year => fetchTennisYear(tour, year)));
  const fromTime = target.getTime() - 365 * 86400000;
  const targetTime = target.getTime();

  const matches = payloads
    .flatMap(item => item.matches)
    .filter(match => {
      const time = Date.parse(match.date || 0);
      return Number.isFinite(time) && time >= fromTime && time < targetTime;
    })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  return {
    tour,
    from: new Date(fromTime).toISOString(),
    to: target.toISOString(),
    matches,
    source_urls: payloads.map(item => item.source_url)
  };
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

function updateElo(ratings, winner, loser, k = 28) {
  const rw = ratings.get(winner) ?? 1500;
  const rl = ratings.get(loser) ?? 1500;
  const ew = expectedScore(rw, rl);
  const delta = k * (1 - ew);
  ratings.set(winner, rw + delta);
  ratings.set(loser, rl - delta);
}

function playerMatches(matches, playerName) {
  const wanted = normalizeName(playerName);
  return matches
    .filter(match => normalizeName(match.winner) === wanted || normalizeName(match.loser) === wanted)
    .map(match => {
      const won = normalizeName(match.winner) === wanted;
      return {
        ...match,
        won,
        opponent: won ? match.loser : match.winner
      };
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

function winPct(rows) {
  return rows.length ? rows.filter(row => row.won).length / rows.length : null;
}

export function calculateTennisModelFromMatches(matches, playerA, playerB, surface) {
  const overall = new Map();
  const surfaces = new Map();

  for (const match of matches) {
    const winner = normalizeName(match.winner);
    const loser = normalizeName(match.loser);
    if (!winner || !loser) continue;

    updateElo(overall, winner, loser, 28);

    const surfaceKey = normalizeSurface(match.surface);
    if (!surfaces.has(surfaceKey)) surfaces.set(surfaceKey, new Map());
    updateElo(surfaces.get(surfaceKey), winner, loser, 30);
  }

  const aKey = normalizeName(playerA);
  const bKey = normalizeName(playerB);
  const selectedSurface = normalizeSurface(surface);
  const surfaceRatings = surfaces.get(selectedSurface) || new Map();

  const aRows = playerMatches(matches, playerA);
  const bRows = playerMatches(matches, playerB);
  const aSurfaceRows = aRows.filter(row => normalizeSurface(row.surface) === selectedSurface);
  const bSurfaceRows = bRows.filter(row => normalizeSurface(row.surface) === selectedSurface);

  const aOverall = overall.get(aKey) ?? 1500;
  const bOverall = overall.get(bKey) ?? 1500;
  const aSurface = surfaceRatings.get(aKey) ?? aOverall;
  const bSurface = surfaceRatings.get(bKey) ?? bOverall;

  const aRecent = aRows.slice(0, 10);
  const bRecent = bRows.slice(0, 10);
  const aRecentSurface = aSurfaceRows.slice(0, 10);
  const bRecentSurface = bSurfaceRows.slice(0, 10);

  const aForm = winPct(aRecent) ?? 0.5;
  const bForm = winPct(bRecent) ?? 0.5;
  const aSurfaceForm = winPct(aRecentSurface) ?? aForm;
  const bSurfaceForm = winPct(bRecentSurface) ?? bForm;

  const ratingDiff =
    0.55 * (aOverall - bOverall) +
    0.35 * (aSurface - bSurface) +
    90 * (aForm - bForm) +
    70 * (aSurfaceForm - bSurfaceForm);

  const probabilityA = 1 / (1 + 10 ** (-ratingDiff / 400));
  const latestTime = Math.max(
    Date.parse(aRows[0]?.date || 0) || 0,
    Date.parse(bRows[0]?.date || 0) || 0
  );

  return {
    surface: selectedSurface,
    probability_a: probabilityA,
    probability_b: 1 - probabilityA,
    latest_match_date: latestTime ? new Date(latestTime).toISOString() : null,
    player_a: {
      name: playerA,
      matches_12m: aRows.length,
      elo: Number(aOverall.toFixed(1)),
      surface_elo: Number(aSurface.toFixed(1)),
      recent_matches: aRecent.length,
      recent_wins: aRecent.filter(row => row.won).length,
      recent_win_pct: Number((100 * aForm).toFixed(1)),
      surface_matches: aSurfaceRows.length,
      surface_recent_matches: aRecentSurface.length,
      surface_recent_wins: aRecentSurface.filter(row => row.won).length,
      surface_win_pct: Number((100 * aSurfaceForm).toFixed(1)),
      latest_match_date: aRows[0]?.date || null
    },
    player_b: {
      name: playerB,
      matches_12m: bRows.length,
      elo: Number(bOverall.toFixed(1)),
      surface_elo: Number(bSurface.toFixed(1)),
      recent_matches: bRecent.length,
      recent_wins: bRecent.filter(row => row.won).length,
      recent_win_pct: Number((100 * bForm).toFixed(1)),
      surface_matches: bSurfaceRows.length,
      surface_recent_matches: bRecentSurface.length,
      surface_recent_wins: bRecentSurface.filter(row => row.won).length,
      surface_win_pct: Number((100 * bSurfaceForm).toFixed(1)),
      latest_match_date: bRows[0]?.date || null
    }
  };
}

export function classifyTennisDataAvailability(aMatches, bMatches, latestMatchDate = null, targetDate = null) {
  const a = Number(aMatches);
  const b = Number(bMatches);
  const valid = Number.isFinite(a) && Number.isFinite(b);
  const minimum = valid ? Math.min(a, b) : 0;

  if (!valid || minimum < 5) {
    return {
      analysis_available: false,
      data_status: 'NEDOSTATEK DAT',
      reliability_status: 'NEDOSTATEK DAT',
      minimum_matches_12m: valid ? minimum : null,
      data_age_days: null
    };
  }

  const targetTime = Date.parse(targetDate || '');
  const latestTime = Date.parse(latestMatchDate || '');
  const dataAgeDays = Number.isFinite(targetTime) && Number.isFinite(latestTime)
    ? Math.max(0, Math.round((targetTime - latestTime) / 86400000))
    : null;
  const limited = minimum < 10 || (Number.isFinite(dataAgeDays) && dataAgeDays > 60);

  return {
    analysis_available: true,
    data_status: limited ? 'OMEZENÁ SPOLEHLIVOST' : 'PŘIPRAVENO',
    reliability_status: limited ? 'OMEZENÁ SPOLEHLIVOST' : 'STANDARDNÍ SPOLEHLIVOST',
    minimum_matches_12m: minimum,
    data_age_days: dataAgeDays
  };
}

export async function loadTennisPlayerModelData(playerA, playerB, selectedFixture) {
  const tour = tennisTourFromSportKey(selectedFixture?.sport_key);
  if (!tour) {
    throw new ProviderError(
      'U tenisového utkání chybí ATP/WTA sport key.',
      { status: 422, code: 'TENNIS_TOUR_UNRESOLVED' }
    );
  }

  const targetDate = selectedFixture?.commence_time || new Date().toISOString();
  const surface = tennisSurfaceFromSportKey(selectedFixture?.sport_key, selectedFixture?.league);
  const rolling = await loadTennisRollingMatches(tour, targetDate);
  const model = calculateTennisModelFromMatches(rolling.matches, playerA, playerB, surface);
  const availability = classifyTennisDataAvailability(
    model.player_a.matches_12m,
    model.player_b.matches_12m,
    model.latest_match_date,
    targetDate
  );

  return {
    ...model,
    ...availability,
    tour,
    rolling_from: rolling.from,
    rolling_to: rolling.to,
    source_urls: rolling.source_urls
  };
}

export async function enrichTennisUpcomingAvailability(events) {
  const byTour = new Map();

  return Promise.all(events.map(async event => {
    try {
      const tour = tennisTourFromSportKey(event.sport_key);
      if (!tour) throw new Error('Nelze určit ATP/WTA okruh.');
      const dateKey = String(event.commence_time || '').slice(0, 10);
      const cacheKey = `${tour}:${dateKey}`;

      let rollingPromise = byTour.get(cacheKey);
      if (!rollingPromise) {
        rollingPromise = loadTennisRollingMatches(tour, event.commence_time);
        byTour.set(cacheKey, rollingPromise);
      }

      const rolling = await rollingPromise;
      const surface = tennisSurfaceFromSportKey(event.sport_key, event.league);
      const model = calculateTennisModelFromMatches(
        rolling.matches,
        event.home_team,
        event.away_team,
        surface
      );
      const status = classifyTennisDataAvailability(
        model.player_a.matches_12m,
        model.player_b.matches_12m,
        model.latest_match_date,
        event.commence_time
      );

      return {
        ...event,
        ...status,
        tennis_tour: tour.toUpperCase(),
        surface,
        rolling_window: {
          from: rolling.from,
          to: rolling.to
        },
        current_form_matches: {
          home: model.player_a.matches_12m,
          away: model.player_b.matches_12m
        }
      };
    } catch (error) {
      console.warn('Tennis availability check failed:', error.message);
      return {
        ...event,
        analysis_available: false,
        data_status: 'NEDOSTATEK DAT',
        reliability_status: 'NEDOSTATEK DAT',
        surface: tennisSurfaceFromSportKey(event.sport_key, event.league),
        current_form_matches: { home: null, away: null },
        availability_error: error.message
      };
    }
  }));
}
