import { TEAM_MAPPING } from './lib/data.mjs';
import { json } from './lib/http.mjs';
export default async request => {
  const sport = new URL(request.url).searchParams.get('sport');
  if (!TEAM_MAPPING[sport]) return json({ error: 'Nepodporovaný sport.' }, 400);
  return json({ sport, teams: Object.keys(TEAM_MAPPING[sport]) });
};
export const config = { path: '/api/teams' };
