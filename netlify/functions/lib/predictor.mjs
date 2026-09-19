import { DEMO_DATA, DEMO_ODDS, SPORT_LABELS } from './data.mjs';
import { clamp, normalCdf, normalizedImpliedProbabilities, recommendation, round, scoreMatrix, valueBet } from './math.mjs';
import {
  fetchEventOdds,
  findMatchOdds,
  getOddsTeamName,
  liveDataEnabled,
  loadApiFootballCzOdds,
  loadLiveFootballTeamData,
  loadNbaTeamStats,
  normName,
  summarizeEventMarkets
} from './providers.mjs';

function diagnostic(error) {
  if (!error) return null;
  return {
    code: error.code || 'UPSTREAM_ERROR',
    message: error.message || 'Live zdroj není dostupný.',
    provider_status: error.providerStatus ?? null,
  };
}

function roundedValues(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value, 1)]));
}

export function bettingFields({ values, best, used, actionable, limitedReliability = false }) {
  const valueAvailable = Boolean(actionable);
  const recommendationAllowed = valueAvailable && !limitedReliability;
  return {
    is_actionable: recommendationAllowed,
    value_available: valueAvailable,
    value_informational_only: valueAvailable && limitedReliability,
    recommendation_allowed: recommendationAllowed,
    market_odds: valueAvailable ? used : null,
    demo_market_odds: valueAvailable ? null : used,
    value_bets: valueAvailable ? roundedValues(values) : null,
    demo_value_bets: valueAvailable ? null : roundedValues(values),
    best_value_market: valueAvailable ? best[0] : null,
    best_value_pct: valueAvailable ? round(best[1], 1) : null,
    recommendation: recommendationAllowed ? recommendation(best[1]) : 'BEZ DOPORUČENÍ',
    recommendation_block_reason: valueAvailable && limitedReliability
      ? 'OMEZENÁ SPOLEHLIVOST'
      : !valueAvailable ? 'NEDOSTUPNÉ REÁLNÉ KURZY' : null,
  };
}

const NATIONAL_TEAMS = new Set(['France', 'Spain', 'Germany', 'Argentina', 'Czechia']);

function isNationalFixture(sport, teamA, teamB) {
  return sport === 'fifa' && NATIONAL_TEAMS.has(teamA) && NATIONAL_TEAMS.has(teamB);
}

function formatSeason(sport, season, teamA, teamB) {
  const start = Number(season);
  if (!Number.isFinite(start)) return null;
  if (isNationalFixture(sport, teamA, teamB)) return String(start);
  return `${start}/${String(start + 1).slice(-2)}`;
}

function seasonStartFromFixtureDate(sport, dateValue, teamA, teamB) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (isNationalFixture(sport, teamA, teamB)) return year;
  return date.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

function currentSeasonStart(sport, teamA, teamB, date = new Date()) {
  const year = date.getUTCFullYear();
  if (isNationalFixture(sport, teamA, teamB)) return year;
  return date.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

function footballFallback(sport, team) {
  return DEMO_DATA?.[sport]?.[team] || {
    attack: sport === 'cz_football' ? 1.45 : 1.55,
    defense: sport === 'cz_football' ? 1.1 : 1.05,
    home_adv: sport === 'cz_football' ? 0.16 : 0.1,
  };
}

async function loadTeamData(sport, team) {
  const fallback = footballFallback(sport, team);

  if (!liveDataEnabled()) {
    return {
      data: fallback,
      mode: 'demo-synthetic',
      diagnostic: { code: 'LIVE_DISABLED', message: 'Live data jsou vypnutá.' }
    };
  }

  if (['cz_football', 'fifa'].includes(sport)) {
    if (!process.env.API_FOOTBALL_KEY) {
      return {
        data: fallback,
        mode: 'demo-synthetic',
        diagnostic: { code: 'MISSING_KEY', message: 'Chybí API_FOOTBALL_KEY.' }
      };
    }

    try {
      const data = await loadLiveFootballTeamData(sport, team, fallback);
      return {
        data,
        mode: data.source_mode || 'api-football-live',
        diagnostic: null,
      };
    } catch (error) {
      console.warn(`API-Football fallback for ${team}:`, error.message);
      return { data: fallback, mode: 'demo-synthetic', diagnostic: diagnostic(error) };
    }
  }

  return { data: fallback, mode: 'demo-synthetic', diagnostic: null };
}

function oddsFromLookup(lookup, sport, teamA) {
  const out = {};
  const eventHome = lookup?.matched_event?.home_team || '';
  const eventAway = lookup?.matched_event?.away_team || '';
  const appHomeIsA = normName(eventHome) === normName(getOddsTeamName(sport, teamA));

  for (const item of lookup?.markets?.moneyline || []) {
    if (String(item.name).toLowerCase() === 'draw') out.draw = Number(item.average_price);
    else if (normName(item.name) === normName(eventHome)) out[appHomeIsA ? 'home' : 'away'] = Number(item.average_price);
    else if (normName(item.name) === normName(eventAway)) out[appHomeIsA ? 'away' : 'home'] = Number(item.average_price);
  }

  const homeSpreads = (lookup?.markets?.spreads || []).filter(item => normName(item.name) === normName(eventHome));
  if (homeSpreads.length) {
    out.spread_home = appHomeIsA ? Number(homeSpreads[0].point) : -Number(homeSpreads[0].point);
    out.spread_home_price = Number(homeSpreads[0].average_price);
  }
  return out;
}

async function selectedOddsLookup(sport, selectedFixture) {
  if (!selectedFixture?.event_id || !selectedFixture?.sport_key) return null;
  const markets = sport === 'nba' ? 'h2h,spreads' : 'h2h';
  const { data } = await fetchEventOdds(
    selectedFixture.sport_key,
    String(selectedFixture.event_id),
    markets
  );
  const summary = summarizeEventMarkets(data);
  return {
    matched_event: {
      id: String(selectedFixture.event_id),
      home_team: data?.home_team || selectedFixture.home_team,
      away_team: data?.away_team || selectedFixture.away_team,
      commence_time: data?.commence_time || selectedFixture.commence_time,
    },
    markets: summary.consensus,
  };
}

async function loadLiveOdds(sport, teamA, teamB, selectedFixture = null) {
  if (!liveDataEnabled()) {
    return {
      odds: null,
      mode: 'demo',
      diagnostic: { code: 'LIVE_DISABLED', message: 'Live kurzy jsou vypnuté.' },
      meta: selectedFixture || null,
    };
  }

  if (sport === 'cz_football') {
    try {
      const result = await loadApiFootballCzOdds(teamA, teamB, selectedFixture);
      const { home, draw, away, ...meta } = result;
      return {
        odds: { home, draw, away },
        mode: 'api-football-odds',
        diagnostic: null,
        meta: { ...(selectedFixture || {}), ...meta },
      };
    } catch (error) {
      console.warn('API-Football odds fallback:', error.message);
      return {
        odds: null,
        mode: 'demo',
        diagnostic: diagnostic(error),
        meta: { ...(selectedFixture || {}), ...(error?.fixtureMeta || {}) },
      };
    }
  }

  if (!process.env.ODDS_API_KEY) {
    return {
      odds: null,
      mode: 'demo',
      diagnostic: { code: 'MISSING_KEY', message: 'Chybí ODDS_API_KEY.' },
      meta: selectedFixture || null,
    };
  }

  try {
    const lookup = await selectedOddsLookup(sport, selectedFixture) || await findMatchOdds({
      sport,
      teamA,
      teamB,
      markets: sport === 'nba' ? 'h2h,spreads' : 'h2h',
    });
    const odds = oddsFromLookup(lookup, sport, teamA);
    return Object.keys(odds).length
      ? {
          odds,
          mode: 'the-odds-api-live',
          diagnostic: null,
          meta: { ...(selectedFixture || {}), ...(lookup?.matched_event || {}) }
        }
      : {
          odds: null,
          mode: 'demo',
          diagnostic: { code: 'EMPTY_MARKET', message: 'Pro vybraný zápas nejsou dostupné požadované kurzy.' },
          meta: selectedFixture || lookup?.matched_event || null
        };
  } catch (error) {
    console.warn('The Odds API fallback:', error.message);
    return {
      odds: null,
      mode: 'demo',
      diagnostic: diagnostic(error),
      meta: selectedFixture || null,
    };
  }
}

export async function predictFootball(sport, aName, bName, supplied = null, selectedFixture = null) {
  const [al, bl] = await Promise.all([loadTeamData(sport, aName), loadTeamData(sport, bName)]);
  const a = al.data;
  const b = bl.data;

  const homeLambda = clamp(a.attack * b.defense * 0.56 + (a.home_adv || 0.12), 0.25, 4.5);
  const awayLambda = clamp(b.attack * a.defense * 0.52, 0.2, 4);
  const [pHome, pDraw, pAway, score] = scoreMatrix(homeLambda, awayLambda, 9);

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: selectedFixture }
    : await loadLiveOdds(sport, aName, bName, selectedFixture);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.football;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    draw: Number(used.draw || 0),
    away: Number(used.away || 0),
  });
  const probs = { home: pHome, draw: pDraw, away: pAway };
  const values = Object.fromEntries(
    Object.entries(probs).map(([key, probability]) => [key, valueBet(probability, market[key] ?? probability)])
  );
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  const dataDiagnostics = [
    al.diagnostic ? { team: aName, ...al.diagnostic } : null,
    bl.diagnostic ? { team: bName, ...bl.diagnostic } : null,
  ].filter(Boolean);

  const dataSeasons = [...new Set([
    ...(Array.isArray(a.seasons_used) ? a.seasons_used : []),
    ...(Array.isArray(b.seasons_used) ? b.seasons_used : []),
  ])].sort((x, y) => y - x);
  const dataSeasonLabel = dataSeasons.length
    ? dataSeasons.map(season => formatSeason(sport, season, aName, bName)).filter(Boolean).join(', ')
    : null;

  const matchDate = selectedFixture?.commence_time || liveResult?.meta?.commence_time || null;
  const targetSeasonStart = seasonStartFromFixtureDate(sport, matchDate, aName, bName)
    ?? currentSeasonStart(sport, aName, bName);
  const targetSeasonLabel = formatSeason(sport, targetSeasonStart, aName, bName);

  const ranges = [
    a?.historical_match_range ? { team: aName, ...a.historical_match_range } : null,
    b?.historical_match_range ? { team: bName, ...b.historical_match_range } : null,
  ].filter(Boolean);
  const rangeDates = ranges
    .flatMap(range => [range.from, range.to])
    .map(value => ({ value, time: Date.parse(value) }))
    .filter(item => Number.isFinite(item.time))
    .sort((x, y) => x.time - y.time);
  const historicalMatchRange = rangeDates.length ? {
    from: rangeDates[0].value,
    to: rangeDates[rangeDates.length - 1].value,
  } : null;

  const latestDataSeason = dataSeasons.length ? Math.max(...dataSeasons) : null;
  const dataAgeSeasons = latestDataSeason == null ? null : Math.max(0, targetSeasonStart - latestDataSeason);
  const limitedReliability = Number.isFinite(dataAgeSeasons) && dataAgeSeasons > 1;
  const reliabilityLabel = dataAgeSeasons == null
    ? null
    : limitedReliability ? 'OMEZENÁ SPOLEHLIVOST' : 'STANDARDNÍ SPOLEHLIVOST';

  return {
    sport,
    sport_label: SPORT_LABELS[sport],
    model: 'Poisson goals model',
    team_a: aName,
    team_b: bName,
    selected_fixture: selectedFixture,
    expected_score: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    most_likely_score: { home: score[0], away: score[1] },
    probabilities: Object.fromEntries(
      Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])
    ),
    ...bettingFields({ values, best, used, actionable, limitedReliability }),
    data_mode: al.mode.startsWith('api-football-') && bl.mode.startsWith('api-football-')
      ? (al.mode === bl.mode ? al.mode : 'api-football-mixed')
      : 'demo-synthetic',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    data_seasons: dataSeasons,
    data_season_label: dataSeasonLabel,
    target_season_label: targetSeasonLabel,
    match_date: matchDate,
    historical_match_range: historicalMatchRange,
    historical_match_range_by_team: ranges,
    data_age_seasons: dataAgeSeasons,
    limited_reliability: limitedReliability,
    reliability_label: reliabilityLabel,
    data_matches_used: {
      team_a: Number.isFinite(Number(a.matches_used)) ? Number(a.matches_used) : null,
      team_b: Number.isFinite(Number(b.matches_used)) ? Number(b.matches_used) : null,
    },
    data_diagnostics: dataDiagnostics,
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictNba(aName, bName, supplied = null, selectedFixture = null) {
  const targetDate = selectedFixture?.commence_time || new Date().toISOString();
  const [a, b] = await Promise.all([
    loadNbaTeamStats(aName, targetDate),
    loadNbaTeamStats(bName, targetDate)
  ]);

  const expectedPace = (a.pace + b.pace) / 2;
  const ratingHome = expectedPace * ((a.offensive_rating + b.defensive_rating) / 2) / 100 + 2.2;
  const ratingAway = expectedPace * ((b.offensive_rating + a.defensive_rating) / 2) / 100;

  const homeFormEstimate = Number.isFinite(a.home_form?.ppg) && Number.isFinite(b.away_form?.papg)
    ? (a.home_form.ppg + b.away_form.papg) / 2
    : null;
  const awayFormEstimate = Number.isFinite(b.away_form?.ppg) && Number.isFinite(a.home_form?.papg)
    ? (b.away_form.ppg + a.home_form.papg) / 2
    : null;

  const home = clamp(
    Number.isFinite(homeFormEstimate) ? 0.75 * ratingHome + 0.25 * homeFormEstimate : ratingHome,
    85,
    145
  );
  const away = clamp(
    Number.isFinite(awayFormEstimate) ? 0.75 * ratingAway + 0.25 * awayFormEstimate : ratingAway,
    85,
    145
  );

  const margin = home - away;
  const pHome = 1 - normalCdf(0, margin, 11.5);
  const pAway = 1 - pHome;

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: selectedFixture }
    : await loadLiveOdds('nba', aName, bName, selectedFixture);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.nba;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    away: Number(used.away || 0)
  });
  const spread = Number.isFinite(Number(used.spread_home)) ? Number(used.spread_home) : null;
  const pHomeCover = Number.isFinite(spread) ? 1 - normalCdf(-spread, margin, 11.5) : null;

  const probs = {
    home_moneyline: pHome,
    away_moneyline: pAway,
    ...(Number.isFinite(pHomeCover) ? {
      home_cover: pHomeCover,
      away_cover: 1 - pHomeCover
    } : {})
  };

  const values = {
    home_moneyline: valueBet(pHome, market.home ?? pHome),
    away_moneyline: valueBet(pAway, market.away ?? pAway),
  };
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  const rangeTimes = [
    a?.range?.from,a?.range?.to,b?.range?.from,b?.range?.to
  ].filter(Boolean).map(value=>({value,time:Date.parse(value)})).filter(x=>Number.isFinite(x.time)).sort((x,y)=>x.time-y.time);
  const historicalMatchRange = rangeTimes.length ? {
    from: rangeTimes[0].value,
    to: rangeTimes[rangeTimes.length - 1].value
  } : null;

  const latestGameTime = Math.max(
    Date.parse(a.last_game_date || 0) || 0,
    Date.parse(b.last_game_date || 0) || 0
  );
  const targetTime = Date.parse(targetDate || 0);
  const dataAgeDays = latestGameTime && targetTime
    ? Math.max(0, Math.round((targetTime - latestGameTime) / 86400000))
    : null;
  const limitedReliability = Number.isFinite(dataAgeDays) && dataAgeDays > 120;

  return {
    sport: 'nba',
    sport_label: SPORT_LABELS.nba,
    model: 'Last-10 pace + offensive/defensive rating + home/away form',
    team_a: aName,
    team_b: bName,
    selected_fixture: selectedFixture,
    expected_score: { home: round(home, 1), away: round(away, 1) },
    expected_margin: round(margin, 1),
    expected_pace: round(expectedPace, 1),
    spread_home: Number.isFinite(spread) ? spread : null,
    probabilities: Object.fromEntries(
      Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])
    ),
    ...bettingFields({ values, best, used, actionable, limitedReliability }),
    data_mode: 'espn-nba-last10',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    match_date: selectedFixture?.commence_time || liveResult?.meta?.commence_time || null,
    historical_match_range: historicalMatchRange,
    data_age_days: dataAgeDays,
    limited_reliability: limitedReliability,
    reliability_label: limitedReliability ? 'OMEZENÁ SPOLEHLIVOST' : 'STANDARDNÍ SPOLEHLIVOST',
    data_matches_used: {
      team_a: a.matches_used,
      team_b: b.matches_used,
    },
    nba_team_stats: {
      team_a: a,
      team_b: b
    },
    data_source_note: 'ESPN NBA game summaries; pace a offensive/defensive rating jsou dopočítané z boxscore possessions.',
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictNhl(aName, bName, supplied = null, selectedFixture = null) {
  const defaults = { attack: 3.05, defense: 3.05, goalie: 1, powerplay: 1, home_adv: 0.12 };
  const hasTeamData = Boolean(DEMO_DATA.nhl[aName] && DEMO_DATA.nhl[bName]);
  const a = DEMO_DATA.nhl[aName] || defaults;
  const b = DEMO_DATA.nhl[bName] || defaults;

  const homeLambda = clamp(a.attack * b.defense / 3 * a.powerplay / b.goalie + a.home_adv, 1.2, 5.5);
  const awayLambda = clamp(b.attack * a.defense / 3 * b.powerplay / a.goalie, 1.1, 5.2);
  const [pHome, pDraw, pAway, score] = scoreMatrix(homeLambda, awayLambda, 10);

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: selectedFixture }
    : await loadLiveOdds('nhl', aName, bName, selectedFixture);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.nhl;
  const actionable = Boolean(supplied || live) && hasTeamData;

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    draw: Number(used.draw || 0),
    away: Number(used.away || 0),
  });
  const probs = { home: pHome, draw: pDraw, away: pAway };
  const values = Object.fromEntries(
    Object.entries(probs).map(([key, probability]) => [key, valueBet(probability, market[key] ?? probability)])
  );
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];
  const limitedReliability = !hasTeamData;

  return {
    sport: 'nhl',
    sport_label: SPORT_LABELS.nhl,
    model: hasTeamData ? 'Poisson goals + goalie/powerplay model' : 'League-average Poisson fallback',
    team_a: aName,
    team_b: bName,
    selected_fixture: selectedFixture,
    expected_score: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    most_likely_score: { home: score[0], away: score[1] },
    probabilities: Object.fromEntries(
      Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])
    ),
    ...bettingFields({ values, best, used, actionable, limitedReliability }),
    data_mode: hasTeamData ? 'demo-synthetic-team' : 'demo-synthetic-league-average',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    match_date: selectedFixture?.commence_time || liveResult?.meta?.commence_time || null,
    limited_reliability: limitedReliability,
    reliability_label: hasTeamData ? 'STANDARDNÍ DEMO MODEL' : 'OMEZENÁ SPOLEHLIVOST',
    data_diagnostics: hasTeamData ? [] : [{
      team: `${aName} / ${bName}`,
      code: 'LEAGUE_AVERAGE_FALLBACK',
      message: 'Pro tuto dvojici zatím nejsou v modelu týmové statistiky; používá se ligový průměr.'
    }],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictMatch(sport, a, b, odds = null, selectedFixture = null) {
  if (!sport || !a || !b) throw new TypeError('Chybí sport nebo tým.');
  if (a === b) throw new TypeError('Vyber dva různé týmy.');
  if (['cz_football', 'fifa'].includes(sport)) return predictFootball(sport, a, b, odds, selectedFixture);
  if (sport === 'nba') return predictNba(a, b, odds, selectedFixture);
  if (sport === 'nhl') return predictNhl(a, b, odds, selectedFixture);
  throw new TypeError('Nepodporovaný sport.');
}
