import { json } from './lib/http.mjs';
import { predictMatch } from './lib/predictor.mjs';
import { savePredictionSnapshot } from './lib/tracker.mjs';
export default async request => {
  if (request.method !== 'POST') return json({ error: 'Použij POST.' }, 405);
  try {
    const body = await request.json();
    const result = await predictMatch(body.sport, body.team_a, body.team_b, body.odds || null, body.fixture || null);
    let tracker;
    try {
      tracker = await savePredictionSnapshot(result, body.fixture || null);
    } catch (trackerError) {
      console.warn('Prediction Tracker save failed:', trackerError.message);
      tracker = { saved: false, reason: 'TRACKER_SAVE_FAILED' };
    }
    return json({ ...result, tracker });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'Neplatný JSON.' }, 400);
    return json({
      error: error.message || 'Chyba predikce.',
      code: error.code || null,
      provider_status: error.providerStatus ?? null
    }, error.status || (error instanceof TypeError ? 400 : 500));
  }
};
export const config = { path: '/api/predict' };
