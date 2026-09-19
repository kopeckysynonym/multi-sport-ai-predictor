import { listPredictionEntries, updatePredictionSnapshot } from './tracker.mjs';
import { syncSettlementToSharePoint } from './sharepoint-sync.mjs';

function env(name) {
  try {
    return globalThis.Netlify?.env?.get?.(name) || null;
  } catch {
    return null;
  }
}

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function scoreNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventScores(event, snapshot) {
  const rows = Array.isArray(event?.scores) ? event.scores : [];
  const homeName = event?.home_team || snapshot?.match?.home_team;
  const awayName = event?.away_team || snapshot?.match?.away_team;

  const byName = new Map(rows.map(row => [norm(row?.name), scoreNumber(row?.score)]));
  const home = byName.get(norm(homeName));
  const away = byName.get(norm(awayName));

  if (Number.isFinite(home) && Number.isFinite(away)) {
    return { home, away };
  }
  if (rows.length === 2) {
    const first = scoreNumber(rows[0]?.score);
    const second = scoreNumber(rows[1]?.score);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      const firstIsHome = norm(rows[0]?.name) === norm(homeName);
      return firstIsHome ? { home: first, away: second } : { home: second, away: first };
    }
  }
  return null;
}

function outcomeFromScore(snapshot, score) {
  const market = snapshot?.tracked_market;
  if (!market || !score) return null;

  const homeWon = score.home > score.away;
  const awayWon = score.away > score.home;
  const draw = score.home === score.away;

  if (market === 'draw') return draw ? 'WIN' : 'LOSS';
  if (market === 'home' || market === 'home_moneyline') {
    if (draw && market === 'home_moneyline') return 'PUSH';
    return homeWon ? 'WIN' : 'LOSS';
  }
  if (market === 'away' || market === 'away_moneyline') {
    if (draw && market === 'away_moneyline') return 'PUSH';
    return awayWon ? 'WIN' : 'LOSS';
  }
  return null;
}
function chanceLigaTeamCode(value) {
  const key = norm(value);
  const aliases = [
    ['spartapraha', 'ACS'],
    ['slaviapraha', 'SKS'],
    ['viktoriaplzen', 'PLZ'],
    ['banikostrava', 'FCB'],
    ['sigmaolomouc', 'SIG'],
    ['hradeckralove', 'HKR'],
    ['teplice', 'TEP'],
    ['jablonec', 'FKJ'],
    ['slovacko', 'FCS'],
    ['pardubice', 'FKP'],
    ['mladaboleslav', 'MBL'],
    ['slovanliberec', 'LIB'],
    ['bohemianspraha1905', 'BOH'],
    ['bohemians1905', 'BOH'],
    ['zbrojovkabrno', 'ZBR'],
    ['artisbrno', 'ART'],
    ['zlin', 'FCZ'],
  ];
  return aliases.find(([needle]) => key.includes(needle))?.[1] || null;
}

function chanceLigaDateParts(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  const fullYear = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
  }).format(date));
  const month = Number(parts.month);
  return {
    display: parts.day + '/' + parts.month + '/' + parts.year,
    month,
    seasonEndYear: month >= 7 ? fullYear + 1 : fullYear,
  };
}

function chanceLigaPlainText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

export function extractChanceLigaScoreFromHtml(html, snapshot) {
  const date = chanceLigaDateParts(snapshot?.match?.commence_time);
  const home = chanceLigaTeamCode(snapshot?.match?.home_team);
  const away = chanceLigaTeamCode(snapshot?.match?.away_team);
  if (!date || !home || !away) return null;

  const text = chanceLigaPlainText(html);
  const pattern = new RegExp(
    regexEscape(date.display) + '[\\s\\S]{0,320}?\\b' + home + '\\b[\\s\\S]{0,80}?(\\d+)\\s*:\\s*(\\d+)(?:\\s*video)?\\s*\\b' + away + '\\b',
    'i'
  );
  const match = text.match(pattern);
  if (!match) return null;

  const homeScore = scoreNumber(match[1]);
  const awayScore = scoreNumber(match[2]);
  return Number.isFinite(homeScore) && Number.isFinite(awayScore)
    ? { home: homeScore, away: awayScore }
    : null;
}

async function chanceLigaOfficialScore(snapshot, nowMs) {
  const matchMs = Date.parse(snapshot?.match?.commence_time || '');
  if (!Number.isFinite(matchMs) || nowMs - matchMs < 3 * 60 * 60 * 1000) return null;

  const date = chanceLigaDateParts(snapshot?.match?.commence_time);
  if (!date) return null;

  const url = new URL('https://www.chanceliga.cz/rozpis-zapasu/' + date.seasonEndYear);
  url.searchParams.set('id_stage', '1');
  url.searchParams.set('month', String(date.month));
  url.searchParams.set('round', '0');
  url.searchParams.set('type', '2');

  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Multi-Sport-AI-Predictor/1.0',
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) {
    throw Object.assign(new Error('Chance Liga result page: HTTP ' + response.status), {
      status: response.status,
      code: 'CHANCE_LIGA_RESULT_ERROR',
    });
  }

  return extractChanceLigaScoreFromHtml(await response.text(), snapshot);
}

export function settlePaperBet(snapshot, score, source = 'unknown', settledAt = new Date().toISOString()) {
  if (!score || !Number.isFinite(Number(score.home)) || !Number.isFinite(Number(score.away))) return null;

  const settlement = {
    status: 'SETTLED',
    settled_at: settledAt,
    source,
    actual_score: {
      home: Number(score.home),
      away: Number(score.away)
    },
    actual_result: Number(score.home) > Number(score.away)
      ? 'HOME'
      : Number(score.away) > Number(score.home)
        ? 'AWAY'
        : 'DRAW',
    simulated_bet: null
  };

  const outcome = outcomeFromScore(snapshot, score);
  const odds = Number(snapshot?.tracked_odds);
  if (!outcome || !Number.isFinite(odds) || odds <= 1) return settlement;

  const stake = 1;
  const profit = outcome === 'WIN' ? odds - stake : outcome === 'LOSS' ? -stake : 0;
  settlement.simulated_bet = {
    stake_units: stake,
    outcome,
    profit_units: Number(profit.toFixed(3)),
    return_units: Number((stake + profit).toFixed(3))
  };
  return settlement;
}

async function oddsApiScores(sportKey, eventIds = []) {
  const apiKey = env('ODDS_API_KEY');
  if (!apiKey) throw Object.assign(new Error('Chybí ODDS_API_KEY.'), { code: 'MISSING_ODDS_API_KEY' });

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/scores/`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('daysFrom', '3');
  url.searchParams.set('dateFormat', 'iso');
  if (eventIds.length) url.searchParams.set('eventIds', eventIds.join(','));

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(9000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.error_code || `HTTP ${response.status}`;
    throw Object.assign(new Error(`The Odds API scores: ${message}`), {
      status: response.status,
      code: data?.error_code || 'ODDS_SCORES_ERROR'
    });
  }
  return Array.isArray(data) ? data : [];
}

async function apiFootballFixture(fixtureId) {
  const apiKey = env('API_FOOTBALL_KEY');
  if (!apiKey) throw Object.assign(new Error('Chybí API_FOOTBALL_KEY.'), { code: 'MISSING_API_FOOTBALL_KEY' });

  const url = new URL('https://v3.football.api-sports.io/fixtures');
  url.searchParams.set('id', String(fixtureId));
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-apisports-key': apiKey
    },
    signal: AbortSignal.timeout(9000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(`API-Football fixture: HTTP ${response.status}`), {
      status: response.status,
      code: 'API_FOOTBALL_RESULT_ERROR'
    });
  }

  const item = payload?.response?.[0];
  const short = String(item?.fixture?.status?.short || '').toUpperCase();
  if (!['FT', 'AET', 'PEN'].includes(short)) return null;

  const fullTimeHome = scoreNumber(item?.score?.fulltime?.home);
  const fullTimeAway = scoreNumber(item?.score?.fulltime?.away);
  const home = Number.isFinite(fullTimeHome) ? fullTimeHome : scoreNumber(item?.goals?.home);
  const away = Number.isFinite(fullTimeAway) ? fullTimeAway : scoreNumber(item?.goals?.away);
  return Number.isFinite(home) && Number.isFinite(away) ? { home, away } : null;
}

function canUseOddsScores(snapshot, nowMs) {
  const sportKey = snapshot?.match?.sport_key;
  const eventId = snapshot?.match?.event_id;
  const matchMs = Date.parse(snapshot?.match?.commence_time || '');
  if (!sportKey || !eventId || !Number.isFinite(matchMs) || matchMs > nowMs) return false;
  return nowMs - matchMs <= 4 * 86400000;
}

function pendingEntries(entries, nowMs) {
  return entries.filter(({ snapshot }) => {
    if (snapshot?.settlement?.status === 'SETTLED') return false;
    const matchMs = Date.parse(snapshot?.match?.commence_time || '');
    return Number.isFinite(matchMs) && matchMs < nowMs;
  });
}

export async function settlePendingPredictions({ now = new Date(), limit = 100 } = {}) {
  const nowMs = now.getTime();
  const entries = pendingEntries(await listPredictionEntries(), nowMs).slice(0, limit);
  const updates = [];
  const diagnostics = [];

  const oddsEntries = entries.filter(({ snapshot }) => canUseOddsScores(snapshot, nowMs));
  const bySportKey = new Map();
  for (const entry of oddsEntries) {
    const key = entry.snapshot.match.sport_key;
    if (!bySportKey.has(key)) bySportKey.set(key, []);
    bySportKey.get(key).push(entry);
  }

  const oddsResults = new Map();
  for (const [sportKey, group] of bySportKey) {
    try {
      const ids = [...new Set(group.map(entry => String(entry.snapshot.match.event_id)))];
      const rows = await oddsApiScores(sportKey, ids);
      for (const row of rows) oddsResults.set(String(row?.id), row);
    } catch (error) {
      diagnostics.push({ source: 'the-odds-api-scores', sport_key: sportKey, message: error.message });
    }
  }

  for (const entry of entries) {
    const snapshot = entry.snapshot;
    let settlement = null;

    if (snapshot?.sport === 'cz_football') {
      if (snapshot?.match?.fixture_id) {
        try {
          const score = await apiFootballFixture(snapshot.match.fixture_id);
          if (score) settlement = settlePaperBet(snapshot, score, 'api-football', now.toISOString());
        } catch (error) {
          diagnostics.push({ record_id: snapshot.record_id, source: 'api-football', message: error.message });
        }
      }

      if (!settlement) {
        try {
          const score = await chanceLigaOfficialScore(snapshot, nowMs);
          if (score) settlement = settlePaperBet(snapshot, score, 'chance-liga-official', now.toISOString());
        } catch (error) {
          diagnostics.push({ record_id: snapshot.record_id, source: 'chance-liga-official', message: error.message });
        }
      }
    } else if (snapshot?.match?.event_id) {
      const event = oddsResults.get(String(snapshot.match.event_id));
      if (event?.completed) {
        const score = eventScores(event, snapshot);
        if (score) settlement = settlePaperBet(snapshot, score, 'the-odds-api-scores', now.toISOString());
      }
    }

    if (settlement) {
      let next = { ...snapshot, settlement };
      await updatePredictionSnapshot(entry.key, next);

      try {
        const sharepointSettlement = await syncSettlementToSharePoint(next, settlement);
        next = {
          ...next,
          sharepoint_settlement_sync: {
            status: 'SYNCED',
            item_id: sharepointSettlement.item_id || null,
            synced_at: now.toISOString(),
          },
        };
        await updatePredictionSnapshot(entry.key, next);
      } catch (sharePointError) {
        diagnostics.push({
          record_id: snapshot.record_id,
          source: 'sharepoint-settlement',
          code: sharePointError.code || 'SHAREPOINT_SETTLEMENT_SYNC_FAILED',
          message: sharePointError.message,
        });
      }

      updates.push(next);
    }
  }

  return {
    checked: entries.length,
    settled: updates.length,
    diagnostics
  };
}

export function trackerPerformanceSummary(predictions = []) {
  const settled = predictions.filter(row =>
    row?.settlement?.status === 'SETTLED' &&
    Number.isFinite(Number(row?.settlement?.simulated_bet?.profit_units))
  );
  const stakeUnits = settled.reduce(
    (sum, row) => sum + Number(row?.settlement?.simulated_bet?.stake_units || 0),
    0
  );
  const profitUnits = settled.reduce(
    (sum, row) => sum + Number(row?.settlement?.simulated_bet?.profit_units || 0),
    0
  );
  const wins = settled.filter(row => row?.settlement?.simulated_bet?.outcome === 'WIN').length;
  const losses = settled.filter(row => row?.settlement?.simulated_bet?.outcome === 'LOSS').length;
  const pushes = settled.filter(row => row?.settlement?.simulated_bet?.outcome === 'PUSH').length;

  return {
    settled_bets: settled.length,
    wins,
    losses,
    pushes,
    stake_units: Number(stakeUnits.toFixed(3)),
    profit_units: Number(profitUnits.toFixed(3)),
    roi_pct: stakeUnits > 0 ? Number(((profitUnits / stakeUnits) * 100).toFixed(1)) : null
  };
}
