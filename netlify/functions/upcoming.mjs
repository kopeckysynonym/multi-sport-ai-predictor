import { json } from './lib/http.mjs';
import { SPORT_LABELS } from './lib/data.mjs';
import { listUpcomingMatches } from './lib/providers.mjs';

export default async request => {
  try {
    const url = new URL(request.url);
    const sport = url.searchParams.get('sport') || 'cz_football';
    if (!SPORT_LABELS[sport]) return json({ error: 'Nepodporovaný sport.' }, 400);

    const events = await listUpcomingMatches(sport);
    return json({
      sport,
      sport_label: SPORT_LABELS[sport],
      count: events.length,
      events,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    return json({
      error: error.message || 'Nepodařilo se načíst nadcházející zápasy.',
      code: error.code || 'UPCOMING_ERROR',
      provider_status: error.providerStatus ?? null
    }, error.status || (error instanceof TypeError ? 400 : 502));
  }
};

export const config = { path: '/api/upcoming' };
