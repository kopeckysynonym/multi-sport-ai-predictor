import { DEMO_DATA, DEMO_ODDS, SPORT_LABELS } from './data.mjs';
import { clamp, expectedRoi, normalCdf, normalizedImpliedProbabilities, recommendation, round, scoreMatrix, valueBet } from './math.mjs';
import { loadTennisPlayerModelData } from './tennis.mjs';
import {
  fetchEventOdds,
  findMatchOdds,
  fifaSeasonForFixture,
  fifaSeasonLabelForFixture,
  getOddsTeamName,
  liveDataEnabled,
  loadApiFootballCzOdds,
  loadFifaTeamCurrentSeasonData,
  loadLiveFootballTeamData,
  loadNbaTeamStats,
  loadNhlTeamStats,
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

export function bettingFields({
  values,
  roiValues = {},
  best,
  used,
  actionable,
  limitedReliability = false
}) {
  const valueAvailable = Boolean(actionable);
  const recommendationAllowed = valueAvailable && !limitedReliability;
  const bestMarket = valueAvailable ? best?.[0] || null : null;
  const bestEdge = bestMarket != null ? Number(values?.[bestMarket]) : NaN;
  const bestRoi = bestMarket != null ? Number(roiValues?.[bestMarket]) : NaN;
  return {
    is_actionable: recommendationAllowed,
    value_available: valueAvailable,
    value_informational_only: valueAvailable && limitedReliability,
    recommendation_allowed: recommendationAllowed,
    market_odds: valueAvailable ? used : null,
    demo_market_odds: valueAvailable ? null : used,
    edge_by_market: valueAvailable ? roundedValues(values) : null,
    expected_roi_by_market: valueAvailable ? roundedValues(roiValues) : null,
    value_bets: valueAvailable ? roundedValues(values) : null,
    demo_value_bets: valueAvailable ? null : roundedValues(values),
    best_value_market: bestMarket,
    best_edge_pct: valueAvailable && Number.isFinite(bestEdge) ? round(bestEdge, 1) : null,
    best_expected_roi_pct: valueAvailable && Number.isFinite(bestRoi) ? round(bestRoi, 1) : null,
    best_value_pct: valueAvailable && Number.isFinite(bestEdge) ? round(bestEdge, 1) : null,
    recommendation: recommendationAllowed && Number.isFinite(bestRoi)
      ? recommendation(bestRoi)
      : 'BEZ DOPORUČENÍ',
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

async function loadTeamData(sport, team, selectedFixture = null) {
  const fallback = footballFallback(sport, team);

  if (!liveDataEnabled()) {
    return {
      data: fallback,
      mode: 'demo-synthetic',
      diagnostic: { code: 'LIVE_DISABLED', message: 'Live data jsou vypnutá.' }
    };
  }

  if (sport === 'fifa') {
    if (!process.env.API_FOOTBALL_KEY) {
      throw Object.assign(new Error('Chybí API_FOOTBALL_KEY.'), {
        status: 503,
        code: 'MISSING_KEY'
      });
    }
    const fixture = selectedFixture || { commence_time: new Date().toISOString() };
    const data = await loadFifaTeamCurrentSeasonData(team, fixture, 10);
    return {
      data,
      mode: data.source_mode || 'api-football-current-season',
      diagnostic: null,
    };
  }

  if (sport === 'cz_football') {
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
  const [al, bl] = await Promise.all([
    loadTeamData(sport, aName, selectedFixture),
    loadTeamData(sport, bName, selectedFixture)
  ]);
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
  const roiValues = Object.fromEntries(
    Object.entries(probs).map(([key, probability]) => [
      key,
      expectedRoi(probability, Number(used[key]))
    ])
  );
  const best = Object.entries(roiValues)
    .filter(([,value])=>Number.isFinite(value))
    .sort((x, y) => y[1] - x[1])[0] || Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  const dataDiagnostics = [
    al.diagnostic ? { team: aName, ...al.diagnostic } : null,
    bl.diagnostic ? { team: bName, ...bl.diagnostic } : null,
  ].filter(Boolean);

  const dataSeasons = [...new Set([
    ...(Array.isArray(a.seasons_used) ? a.seasons_used : []),
    ...(Array.isArray(b.seasons_used) ? b.seasons_used : []),
  ])].sort((x, y) => y - x);
  const dataSeasonLabel = sport === 'fifa'
    ? (a.season_label === b.season_label
        ? a.season_label
        : [a.season_label,b.season_label].filter(Boolean).join(' / '))
    : dataSeasons.length
      ? dataSeasons.map(season => formatSeason(sport, season, aName, bName)).filter(Boolean).join(', ')
      : null;

  const matchDate = selectedFixture?.commence_time || liveResult?.meta?.commence_time || null;
  const targetSeasonStart = sport === 'fifa'
    ? fifaSeasonForFixture(selectedFixture || { commence_time: matchDate })
    : seasonStartFromFixtureDate(sport, matchDate, aName, bName)
      ?? currentSeasonStart(sport, aName, bName);
  const targetSeasonLabel = sport === 'fifa'
    ? fifaSeasonLabelForFixture(targetSeasonStart, selectedFixture || { commence_time: matchDate })
    : formatSeason(sport, targetSeasonStart, aName, bName);

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
  const incompleteCurrentSeasonSample =
    sport === 'fifa' && (Number(a.matches_used) < 10 || Number(b.matches_used) < 10);
  const limitedReliability =
    (Number.isFinite(dataAgeSeasons) && dataAgeSeasons > 1) ||
    incompleteCurrentSeasonSample;
  const reliabilityLabel = dataAgeSeasons == null && sport !== 'fifa'
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
    ...bettingFields({ values, roiValues, best, used, actionable, limitedReliability }),
    data_mode: al.mode.startsWith('api-football-') && bl.mode.startsWith('api-football-')
      ? (al.mode === bl.mode ? al.mode : 'api-football-mixed')
      : 'demo-synthetic',
    current_season_only: sport === 'fifa',
    current_season_sample_complete: sport === 'fifa'
      ? Number(a.matches_used) >= 10 && Number(b.matches_used) >= 10
      : null,
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
    fifa_team_stats: sport === 'fifa' ? {
      team_a: a,
      team_b: b
    } : null,
    data_source_note: sport === 'fifa'
      ? 'Pouze aktuální FIFA/UEFA sezona nebo turnajový ročník; maximálně 10 posledních dokončených zápasů. Starší sezony se nepoužívají.'
      : undefined,
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
  const roiValues = {
    home_moneyline: expectedRoi(pHome, Number(used.home)),
    away_moneyline: expectedRoi(pAway, Number(used.away)),
  };
  const best = Object.entries(roiValues)
    .filter(([,value])=>Number.isFinite(value))
    .sort((x, y) => y[1] - x[1])[0] || Object.entries(values).sort((x, y) => y[1] - x[1])[0];

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
  const incompleteCurrentSeasonSample = a.matches_used < 10 || b.matches_used < 10;
  const limitedReliability =
    (Number.isFinite(dataAgeDays) && dataAgeDays > 120) ||
    incompleteCurrentSeasonSample;
  const commonSeasonLabel = a.season_label === b.season_label
    ? a.season_label
    : [a.season_label,b.season_label].filter(Boolean).join(' / ');

  return {
    sport: 'nba',
    sport_label: SPORT_LABELS.nba,
    model: 'Current-season up-to-10 pace + offensive/defensive rating + home/away form',
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
    ...bettingFields({ values, roiValues, best, used, actionable, limitedReliability }),
    data_mode: 'espn-nba-current-season-last10',
    data_season_label: commonSeasonLabel || null,
    current_season_only: true,
    current_season_sample_complete: !incompleteCurrentSeasonSample,
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
    data_source_note: 'Pouze aktuální NBA sezona; maximálně 10 posledních dokončených zápasů. Starší sezony jsou vyřazené. Pace a offensive/defensive rating jsou dopočítané z ESPN boxscore possessions.',
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictNhl(aName, bName, supplied = null, selectedFixture = null) {
  const targetDate = selectedFixture?.commence_time || new Date().toISOString();
  const [a, b] = await Promise.all([
    loadNhlTeamStats(aName, targetDate),
    loadNhlTeamStats(bName, targetDate)
  ]);

  const baseHome = (a.goals_for + b.goals_against) / 2;
  const baseAway = (b.goals_for + a.goals_against) / 2;

  const homeShots = Number.isFinite(a.shots_for) && Number.isFinite(b.shots_against)
    ? (a.shots_for + b.shots_against) / 2
    : null;
  const awayShots = Number.isFinite(b.shots_for) && Number.isFinite(a.shots_against)
    ? (b.shots_for + a.shots_against) / 2
    : null;

  const awayGoalieAllowed = Number.isFinite(b.goalie_save_pct)
    ? Math.max(0.04, 1 - b.goalie_save_pct / 100)
    : null;
  const homeGoalieAllowed = Number.isFinite(a.goalie_save_pct)
    ? Math.max(0.04, 1 - a.goalie_save_pct / 100)
    : null;

  const shotModelHome = Number.isFinite(homeShots) && Number.isFinite(awayGoalieAllowed)
    ? homeShots * awayGoalieAllowed
    : null;
  const shotModelAway = Number.isFinite(awayShots) && Number.isFinite(homeGoalieAllowed)
    ? awayShots * homeGoalieAllowed
    : null;

  const homeFormEstimate = Number.isFinite(a.home_form?.gfpg) && Number.isFinite(b.away_form?.gapg)
    ? (a.home_form.gfpg + b.away_form.gapg) / 2
    : null;
  const awayFormEstimate = Number.isFinite(b.away_form?.gfpg) && Number.isFinite(a.home_form?.gapg)
    ? (b.away_form.gfpg + a.home_form.gapg) / 2
    : null;

  let homeLambda = baseHome;
  let awayLambda = baseAway;
  if (Number.isFinite(shotModelHome)) homeLambda = 0.72 * homeLambda + 0.28 * shotModelHome;
  if (Number.isFinite(shotModelAway)) awayLambda = 0.72 * awayLambda + 0.28 * shotModelAway;
  if (Number.isFinite(homeFormEstimate)) homeLambda = 0.82 * homeLambda + 0.18 * homeFormEstimate;
  if (Number.isFinite(awayFormEstimate)) awayLambda = 0.82 * awayLambda + 0.18 * awayFormEstimate;

  homeLambda = clamp(homeLambda + 0.12, 1.2, 5.5);
  awayLambda = clamp(awayLambda, 1.1, 5.2);

  const [pHomeReg, pDrawReg, pAwayReg, score] = scoreMatrix(homeLambda, awayLambda, 10);
  const pHomeMoneyline = pHomeReg + 0.5 * pDrawReg;
  const pAwayMoneyline = pAwayReg + 0.5 * pDrawReg;

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: selectedFixture }
    : await loadLiveOdds('nhl', aName, bName, selectedFixture);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.nhl;
  const actionable = Boolean(supplied || live);

  const hasThreeWayOdds = Number(used.draw) > 1;
  const market = hasThreeWayOdds
    ? normalizedImpliedProbabilities({
        home: Number(used.home || 0),
        draw: Number(used.draw || 0),
        away: Number(used.away || 0),
      })
    : normalizedImpliedProbabilities({
        home: Number(used.home || 0),
        away: Number(used.away || 0),
      });

  const probsForValue = hasThreeWayOdds
    ? { home: pHomeReg, draw: pDrawReg, away: pAwayReg }
    : { home: pHomeMoneyline, away: pAwayMoneyline };

  const values = Object.fromEntries(
    Object.entries(probsForValue).map(([key, probability]) => [
      key,
      valueBet(probability, market[key] ?? probability)
    ])
  );
  const roiValues = Object.fromEntries(
    Object.entries(probsForValue).map(([key, probability]) => [
      key,
      expectedRoi(probability, Number(used[key]))
    ])
  );
  const best = Object.entries(roiValues)
    .filter(([,value])=>Number.isFinite(value))
    .sort((x, y) => y[1] - x[1])[0] || Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  const rangeTimes = [
    a?.range?.from,a?.range?.to,b?.range?.from,b?.range?.to
  ].filter(Boolean)
    .map(value=>({value,time:Date.parse(value)}))
    .filter(item=>Number.isFinite(item.time))
    .sort((x,y)=>x.time-y.time);
  const historicalMatchRange = rangeTimes.length ? {
    from: rangeTimes[0].value,
    to: rangeTimes[rangeTimes.length - 1].value
  } : null;

  const incompleteCurrentSeasonSample = a.matches_used < 10 || b.matches_used < 10;
  const limitedReliability = incompleteCurrentSeasonSample;
  const commonSeasonLabel = a.season_label === b.season_label
    ? a.season_label
    : [a.season_label,b.season_label].filter(Boolean).join(' / ');

  return {
    sport: 'nhl',
    sport_label: SPORT_LABELS.nhl,
    model: 'Current-season up-to-10 Poisson + shots + goalie save% + home/away form',
    team_a: aName,
    team_b: bName,
    selected_fixture: selectedFixture,
    expected_score: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    most_likely_score: { home: score[0], away: score[1] },
    probabilities: {
      home: round(pHomeReg * 100, 1),
      draw: round(pDrawReg * 100, 1),
      away: round(pAwayReg * 100, 1),
      home_moneyline: round(pHomeMoneyline * 100, 1),
      away_moneyline: round(pAwayMoneyline * 100, 1),
    },
    ...bettingFields({ values, roiValues, best, used, actionable, limitedReliability }),
    data_mode: 'nhl-current-season-last10',
    data_season_label: commonSeasonLabel || null,
    current_season_only: true,
    current_season_sample_complete: !incompleteCurrentSeasonSample,
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    match_date: selectedFixture?.commence_time || liveResult?.meta?.commence_time || null,
    historical_match_range: historicalMatchRange,
    limited_reliability: limitedReliability,
    reliability_label: limitedReliability ? 'OMEZENÁ SPOLEHLIVOST' : 'STANDARDNÍ SPOLEHLIVOST',
    data_matches_used: {
      team_a: a.matches_used,
      team_b: b.matches_used,
    },
    nhl_team_stats: {
      team_a: a,
      team_b: b
    },
    data_source_note: 'Pouze aktuální NHL sezona; maximálně 10 posledních dokončených zápasů. Starší sezony jsou vyřazené. Model používá góly, střely na branku, recentní save% brankářů a domácí/venkovní formu z veřejného NHL API.',
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictTennis(aName, bName, supplied = null, selectedFixture = null) {
  if (!selectedFixture?.sport_key || !selectedFixture?.commence_time) {
    throw Object.assign(
      new Error('Tenisová predikce vyžaduje konkrétní nadcházející ATP/WTA utkání.'),
      { status: 422, code: 'TENNIS_FIXTURE_REQUIRED' }
    );
  }

  const data = await loadTennisPlayerModelData(aName, bName, selectedFixture);
  if (!data.analysis_available) {
    throw Object.assign(
      new Error(
        `Pro tenisovou analýzu je potřeba alespoň 5 zápasů za posledních 12 měsíců u obou hráčů. ${aName}: ${data.player_a.matches_12m}, ${bName}: ${data.player_b.matches_12m}.`
      ),
      { status: 422, code: 'TENNIS_NOT_ENOUGH_12M_MATCHES' }
    );
  }

  const pA = data.probability_a;
  const pB = data.probability_b;

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: selectedFixture }
    : await loadLiveOdds('tennis', aName, bName, selectedFixture);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.tennis;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    away: Number(used.away || 0)
  });
  const values = {
    home: valueBet(pA, market.home ?? pA),
    away: valueBet(pB, market.away ?? pB)
  };
  const roiValues = {
    home: expectedRoi(pA, Number(used.home)),
    away: expectedRoi(pB, Number(used.away))
  };
  const best = Object.entries(roiValues)
    .filter(([,value])=>Number.isFinite(value))
    .sort((x, y) => y[1] - x[1])[0] || Object.entries(values).sort((x, y) => y[1] - x[1])[0];
  const limitedReliability = data.data_status !== 'PŘIPRAVENO';
  const predictedWinner = pA >= pB ? aName : bName;
  const predictedWinnerProbability = Math.max(pA, pB);

  return {
    sport: 'tennis',
    sport_label: SPORT_LABELS.tennis,
    model: 'Rolling 12m Elo + surface Elo + recent form',
    team_a: aName,
    team_b: bName,
    selected_fixture: selectedFixture,
    expected_score: null,
    predicted_winner: predictedWinner,
    predicted_winner_probability: round(predictedWinnerProbability * 100, 1),
    surface: data.surface,
    tennis_tour: data.tour.toUpperCase(),
    probabilities: {
      home: round(pA * 100, 1),
      away: round(pB * 100, 1)
    },
    ...bettingFields({ values, roiValues, best, used, actionable, limitedReliability }),
    data_mode: 'tennis-rolling-12m-elo',
    data_season_label: 'Rolling 12 měsíců',
    current_season_only: false,
    rolling_window_days: 365,
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    match_date: selectedFixture.commence_time,
    rolling_window: {
      from: data.rolling_from,
      to: data.rolling_to
    },
    historical_match_range: data.actual_match_range || null,
    latest_available_data_date: data.newest_available_match_date || null,
    latest_available_data_age_days: data.newest_data_age_days,
    data_age_days: data.data_age_days,
    limited_reliability: limitedReliability,
    reliability_label: limitedReliability ? 'OMEZENÁ SPOLEHLIVOST' : 'STANDARDNÍ SPOLEHLIVOST',
    data_matches_used: {
      team_a: data.player_a.matches_12m,
      team_b: data.player_b.matches_12m
    },
    tennis_player_stats: {
      player_a: data.player_a,
      player_b: data.player_b
    },
    data_source_note: 'ATP/WTA výsledky: rolling okno posledních 12 měsíců. UI odděluje hranice rolling okna od skutečného rozsahu zápasů obou hráčů. Model kombinuje celkové Elo, Elo na povrchu a poslední formu; kurzy jsou z The Odds API.',
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic
  };
}

export async function predictMatch(sport, a, b, odds = null, selectedFixture = null) {
  if (!sport || !a || !b) throw new TypeError('Chybí sport nebo tým.');
  if (a === b) throw new TypeError('Vyber dva různé týmy.');
  if (['cz_football', 'fifa'].includes(sport)) return predictFootball(sport, a, b, odds, selectedFixture);
  if (sport === 'nba') return predictNba(a, b, odds, selectedFixture);
  if (sport === 'nhl') return predictNhl(a, b, odds, selectedFixture);
  if (sport === 'tennis') return predictTennis(a, b, odds, selectedFixture);
  throw new TypeError('Nepodporovaný sport.');
}
