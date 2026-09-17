import { json } from './lib/http.mjs';
import { liveDataEnabled } from './lib/providers.mjs';
export default async () => json({
  ok: true,
  runtime: 'netlify-functions-node',
  live_data_enabled: liveDataEnabled(),
  api_football_configured: Boolean(process.env.API_FOOTBALL_KEY),
  odds_api_configured: Boolean(process.env.ODDS_API_KEY),
});
export const config = { path: '/api/health' };
