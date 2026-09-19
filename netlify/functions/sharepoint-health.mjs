import { json } from './lib/http.mjs';
import { getGraphAccessToken } from './lib/sharepoint.mjs';

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || null;
}

export default async request => {
  if (request.method !== 'GET') return json({ error: 'Použij GET.' }, 405);

  const siteId = env('SHAREPOINT_SITE_ID');
  const listId = env('SHAREPOINT_PREDICTIONS_LIST_ID');

  if (!siteId || !listId) {
    return json({
      ok: false,
      configured: false,
      token_ok: false,
      list_ok: false,
      columns_count: null,
      error: 'SharePoint environment variables nejsou kompletní.'
    }, 503);
  }

  try {
    const token = await getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/columns?$select=id,name,displayName,hidden,readOnly`;
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return json({
        ok: false,
        configured: true,
        token_ok: true,
        list_ok: false,
        columns_count: null,
        graph_status: response.status,
        error: payload?.error?.message || `Microsoft Graph HTTP ${response.status}`
      }, 502);
    }

    const columns = Array.isArray(payload?.value) ? payload.value : [];
    const custom = columns
      .filter(column => !column.hidden)
      .map(column => column.name)
      .filter(Boolean);

    return json({
      ok: true,
      configured: true,
      token_ok: true,
      list_ok: true,
      columns_count: columns.length,
      visible_columns: custom,
      ai_predictions_schema_ready: custom.includes('PredictionId') && custom.includes('SourceEventKey')
    });
  } catch (error) {
    return json({
      ok: false,
      configured: true,
      token_ok: false,
      list_ok: false,
      columns_count: null,
      code: error.code || null,
      error: error.message || 'SharePoint health check selhal.'
    }, error.status || 500);
  }
};

export const config = {
  path: '/api/sharepoint-health'
};
