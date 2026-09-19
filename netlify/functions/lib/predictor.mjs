import { DEMO_DATA, DEMO_ODDS, SPORT_LABELS } from './data.mjs';
import { clamp, normalCdf, normalizedImpliedProbabilities, recommendation, round, scoreMatrix, valueBet } from './math.mjs';
import {
  findMatchOdds,
  getOddsTeamName,
  liveDataEnabled,
  loadApiFootballCzOdds,
  loadLiveFootballTeamData,
  normName
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

function bettingFields({ values, best, used, actionable }) {
  return {
    is_actionable: actionable,
    market_odds: actionable ? used : null,
    demo_market_odds: actionable ? null : used,
    value_bets: actionable ? roundedValues(values) : null,
    demo_value_bets: actionable ? null : roundedValues(values),
    best_value_market: actionable ? best[0] : null,
    best_value_pct: actionable ? round(best[1], 1) : null,
    recommendation: actionable ? recommendation(best[1]) : 'BEZ DOPORUČENÍ',
  };
}

async function loadTeamData(sport, team) {
  const fallback = DEMO_DATA?.[sport]?.[team];
  if (!fallback) throw new TypeError(`Tým '${team}' není podporován pro sport '${sport}'.`);

  if (!liveDataEnabled()) {
    return { data: fallback, mode: 'demo-synthetic', diagnostic: { code: 'LIVE_DISABLED', message: 'Live data jsou vypnutá.' } };
  }

  if (['cz_football', 'fifa'].includes(sport)) {
    if (!process.env.API_FOOTBALL_KEY) {
      return { data: fallback, mode: 'demo-synthetic', diagnostic: { code: 'MISSING_KEY', message: 'Chybí API_FOOTBALL_KEY.' } };
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

async function loadLiveOdds(sport, teamA, teamB) {
  if (!liveDataEnabled()) {
    return { odds: null, mode: 'demo', diagnostic: { code: 'LIVE_DISABLED', message: 'Live kurzy jsou vypnuté.' } };
  }

  if (sport === 'cz_football') {
    try {
      const result = await loadApiFootballCzOdds(teamA, teamB);
      const { home, draw, away, ...meta } = result;
      return {
        odds: { home, draw, away },
        mode: 'api-football-odds',
        diagnostic: null,
        meta,
      };
    } catch (error) {
      console.warn('API-Football odds fallback:', error.message);
      return { odds: null, mode: 'demo', diagnostic: diagnostic(error) };
    }
  }

  if (!process.env.ODDS_API_KEY) {
    return { odds: null, mode: 'demo', diagnostic: { code: 'MISSING_KEY', message: 'Chybí ODDS_API_KEY.' } };
  }

  try {
    const lookup = await findMatchOdds({
      sport,
      teamA,
      teamB,
      markets: sport === 'nba' ? 'h2h,spreads' : 'h2h',
    });
    const odds = oddsFromLookup(lookup, sport, teamA);
    return Object.keys(odds).length
      ? { odds, mode: 'the-odds-api-live', diagnostic: null, meta: lookup?.matched_event || null }
      : { odds: null, mode: 'demo', diagnostic: { code: 'EMPTY_MARKET', message: 'Pro nalezený zápas nejsou dostupné požadované kurzy.' } };
  } catch (error) {
    console.warn('The Odds API fallback:', error.message);
    return { odds: null, mode: 'demo', diagnostic: diagnostic(error) };
  }
}

export async function predictFootball(sport, aName, bName, supplied = null) {
  const [al, bl] = await Promise.all([loadTeamData(sport, aName), loadTeamData(sport, bName)]);
  const a = al.data;
  const b = bl.data;

  const homeLambda = clamp(a.attack * b.defense * 0.56 + (a.home_adv || 0.12), 0.25, 4.5);
  const awayLambda = clamp(b.attack * a.defense * 0.52, 0.2, 4);
  const [pHome, pDraw, pAway, score] = scoreMatrix(homeLambda, awayLambda, 9);

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: null }
    : await loadLiveOdds(sport, aName, bName);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.football;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    draw: Number(used.draw || 0),
    away: Number(used.away || 0),
  });
  const probs = { home: pHome, draw: pDraw, away: pAway };
  const values = Object.fromEntries(Object.entries(probs).map(([key, probability]) => [key, valueBet(probability, market[key] ?? probability)]));
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  const dataDiagnostics = [
    al.diagnostic ? { team: aName, ...al.diagnostic } : null,
    bl.diagnostic ? { team: bName, ...bl.diagnostic } : null,
  ].filter(Boolean);

  return {
    sport,
    sport_label: SPORT_LABELS[sport],
    model: 'Poisson goals model',
    team_a: aName,
    team_b: bName,
    expected_score: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    most_likely_score: { home: score[0], away: score[1] },
    probabilities: Object.fromEntries(Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])),
    ...bettingFields({ values, best, used, actionable }),
    data_mode: al.mode.startsWith('api-football-') && bl.mode.startsWith('api-football-')
      ? (al.mode === bl.mode ? al.mode : 'api-football-mixed')
      : 'demo-synthetic',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    data_diagnostics: dataDiagnostics,
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictNba(aName, bName, supplied = null) {
  const a = DEMO_DATA.nba[aName];
  const b = DEMO_DATA.nba[bName];
  if (!a || !b) throw new TypeError('Nepodporovaný NBA tým.');

  const pace = ((a.pace + b.pace) / 2) / 100;
  const home = clamp(((a.offense + b.defense) / 2) * pace * a.injury_factor + 2.4, 85, 140);
  const away = clamp(((b.offense + a.defense) / 2) * pace * b.injury_factor, 85, 140);
  const margin = home - away;
  const pHome = 1 - normalCdf(0, margin, 12);
  const pAway = 1 - pHome;

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: null }
    : await loadLiveOdds('nba', aName, bName);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.nba;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({ home: Number(used.home || 0), away: Number(used.away || 0) });
  const spread = Number.isFinite(Number(used.spread_home)) ? Number(used.spread_home) : -3.5;
  const pHomeCover = 1 - normalCdf(-spread, margin, 12);
  const probs = { home_moneyline: pHome, away_moneyline: pAway, home_cover: pHomeCover, away_cover: 1 - pHomeCover };
  const values = {
    home_moneyline: valueBet(pHome, market.home ?? pHome),
    away_moneyline: valueBet(pAway, market.away ?? pAway),
  };
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  return {
    sport: 'nba',
    sport_label: SPORT_LABELS.nba,
    model: 'Expected-score + normal margin model',
    team_a: aName,
    team_b: bName,
    expected_score: { home: round(home, 1), away: round(away, 1) },
    expected_margin: round(margin, 1),
    spread_home: spread,
    probabilities: Object.fromEntries(Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])),
    ...bettingFields({ values, best, used, actionable }),
    data_mode: 'demo-synthetic',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictNhl(aName, bName, supplied = null) {
  const a = DEMO_DATA.nhl[aName];
  const b = DEMO_DATA.nhl[bName];
  if (!a || !b) throw new TypeError('Nepodporovaný NHL tým.');

  const homeLambda = clamp(a.attack * b.defense / 3 * a.powerplay / b.goalie + a.home_adv, 1.2, 5.5);
  const awayLambda = clamp(b.attack * a.defense / 3 * b.powerplay / a.goalie, 1.1, 5.2);
  const [pHome, pDraw, pAway, score] = scoreMatrix(homeLambda, awayLambda, 10);

  const liveResult = supplied
    ? { odds: null, mode: 'client-supplied', diagnostic: null, meta: null }
    : await loadLiveOdds('nhl', aName, bName);
  const live = liveResult.odds;
  const used = supplied || live || DEMO_ODDS.nhl;
  const actionable = Boolean(supplied || live);

  const market = normalizedImpliedProbabilities({
    home: Number(used.home || 0),
    draw: Number(used.draw || 0),
    away: Number(used.away || 0),
  });
  const probs = { home: pHome, draw: pDraw, away: pAway };
  const values = Object.fromEntries(Object.entries(probs).map(([key, probability]) => [key, valueBet(probability, market[key] ?? probability)]));
  const best = Object.entries(values).sort((x, y) => y[1] - x[1])[0];

  return {
    sport: 'nhl',
    sport_label: SPORT_LABELS.nhl,
    model: 'Poisson goals + goalie/powerplay model',
    team_a: aName,
    team_b: bName,
    expected_score: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    most_likely_score: { home: score[0], away: score[1] },
    probabilities: Object.fromEntries(Object.entries(probs).map(([key, probability]) => [key, round(probability * 100, 1)])),
    ...bettingFields({ values, best, used, actionable }),
    data_mode: 'demo-synthetic',
    odds_mode: supplied ? 'client-supplied' : liveResult.mode,
    odds_meta: supplied ? null : liveResult.meta || null,
    data_diagnostics: [],
    odds_diagnostic: supplied ? null : liveResult.diagnostic,
  };
}

export async function predictMatch(sport, a, b, odds = null) {
  if (!sport || !a || !b) throw new TypeError('Chybí sport nebo tým.');
  if (a === b) throw new TypeError('Vyber dva různé týmy.');
  if (['cz_football', 'fifa'].includes(sport)) return predictFootball(sport, a, b, odds);
  if (sport === 'nba') return predictNba(a, b, odds);
  if (sport === 'nhl') return predictNhl(a, b, odds);
  throw new TypeError('Nepodporovaný sport.');
}
