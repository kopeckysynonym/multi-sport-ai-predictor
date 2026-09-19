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

export function settlePaperBet(snapshot, score, source = 'unknown', settledAt = new Date().toISOString()) {
  const outcome = outcomeFromScore(snapshot, score);
  const odds = Number(snapshot?.tracked_odds);
  if (!outcome || !Number.isFinite(odds) || odds <= 1) return null;

  const stake = 1;
  const profit = outcome === 'WIN' ? odds - stake : outcome === 'LOSS' ? -stake : 0;

  return {
    status: 'SETTLED',
    settled_at: settledAt,
    source,
    actual_score: {
      home: score.home,
      away: score.away
    },
    actual_result: score.home > score.away
      ? 'HOME'
      : score.away > score.home
        ? 'AWAY'
        : 'DRAW',
    simulated_bet: {
      stake_units: stake,
      outcome,
      profit_units: Number(profit.toFixed(3)),
      return_units: Number((stake + profit).toFixed(3))
    }
  };
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

    if (snapshot?.sport === 'cz_football' && snapshot?.match?.fixture_id) {
      try {
        const score = await apiFootballFixture(snapshot.match.fixture_id);
        if (score) settlement = settlePaperBet(snapshot, score, 'api-football', now.toISOString());
      } catch (error) {
        diagnostics.push({ record_id: snapshot.record_id, source: 'api-football', message: error.message });
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
