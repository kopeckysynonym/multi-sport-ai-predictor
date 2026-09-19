import { json } from './lib/http.mjs';
import { listPredictionSnapshots } from './lib/tracker.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'Použij GET.' }, 405);
  try {
    const url = new URL(request.url);
    const sport = url.searchParams.get('sport') || null;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, 100));
    const predictions = await listPredictionSnapshots({ sport, limit });
    return json({
      count: predictions.length,
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
