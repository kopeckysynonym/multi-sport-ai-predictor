import { timingSafeEqual } from 'node:crypto';
import { json } from './lib/http.mjs';
import {
  SharePointPredictionError,
  insertPredictionIfUnique,
} from './lib/sharepoint.mjs';

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || null;
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSyncToken(request) {
  const expected = env('SHAREPOINT_SYNC_TOKEN');
  if (!expected) {
    throw new SharePointPredictionError(
      'Chybí Netlify environment variable SHAREPOINT_SYNC_TOKEN.',
      { status: 503, code: 'SHAREPOINT_NOT_CONFIGURED' }
    );
  }

  const provided = request.headers.get('x-sharepoint-sync-token');
  if (!provided || !secureEqual(provided, expected)) {
    throw new SharePointPredictionError('Neplatná autorizace SharePoint sync endpointu.', {
      status: 401,
      code: 'UNAUTHORIZED',
    });
  }
}

export default async request => {
  if (request.method !== 'POST') return json({ error: 'Použij POST.' }, 405);

  try {
    requireSyncToken(request);

    const body = await request.json();
    const fields = body?.fields;
    const result = await insertPredictionIfUnique(fields);

    return json(
      {
        ok: true,
        ...result,
      },
      result.created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: 'Neplatný JSON.', code: 'INVALID_JSON' }, 400);
    }

    return json(
      {
        error: error.message || 'SharePoint INSERT selhal.',
        code: error.code || 'SHAREPOINT_INSERT_ERROR',
        details: error.details || null,
      },
      error.status || 500
    );
  }
};

export const config = {
  path: '/api/sharepoint-predictions',
};
