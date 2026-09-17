import { TEAM_MAPPING } from './lib/data.mjs';
import { json } from './lib/http.mjs';
export default async request => {
  const sport = new URL(request.url).searchParams.get('sport');
  if (sport && !TEAM_MAPPING[sport]) return json({ error: 'Nepodporovaný sport.' }, 400);
  return json(sport ? { sport, mapping: TEAM_MAPPING[sport] } : { mapping: TEAM_MAPPING });
};
export const config = { path: '/api/team-mapping' };
