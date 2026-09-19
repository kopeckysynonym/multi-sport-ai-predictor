import { json } from './lib/http.mjs';
import { listPredictionEntries } from './lib/tracker.mjs';
import { trackerPerformanceSummary } from './lib/settlement.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'Použij GET.' }, 405);
  try {
    const url = new URL(request.url);
    const sport = url.searchParams.get('sport') || null;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, 100));
    const entries = await listPredictionEntries({ sport });
    const allPredictions = entries
      .map(entry => entry.snapshot)
      .sort((a, b) => Date.parse(b?.prediction_time || 0) - Date.parse(a?.prediction_time || 0));
    const predictions = allPredictions.slice(0, limit);
    return json({
      count: predictions.length,
      total_count: allPredictions.length,
      performance: trackerPerformanceSummary(allPredictions),
      predictions,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    return json({
      error: error.message || 'Prediction Tracker není dostupný.',
      code: error.code || 'TRACKER_ERROR'
    }, 500);
  }
};

export const config = { path: '/api/tracker' };
