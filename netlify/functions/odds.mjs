import { json, ProviderError } from './lib/http.mjs';
import { findMatchOdds } from './lib/providers.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'Použij GET.' }, 405);
  const p = new URL(request.url).searchParams;
  try {
    const result = await findMatchOdds({
      sport: p.get('sport'), teamA: p.get('team_a'), teamB: p.get('team_b'),
      markets: p.get('markets') || 'h2h,spreads,totals', regions: p.get('regions') || null,
    });
    return json(result);
  } catch (error) {
    const status = error instanceof TypeError ? 400 : (error.status || 500);
    const body = { error: error.message || 'Neočekávaná chyba.' };
    if (error instanceof ProviderError && error.providerStatus) body.provider_status = error.providerStatus;
    if (error.code) body.code = error.code;
    return json(body, status);
  }
};
export const config = { path: '/api/odds' };
