export class ProviderError extends Error {
  constructor(message, { providerStatus = null, status = 502, code = 'UPSTREAM_ERROR' } = {}) {
    super(message); this.name = 'ProviderError'; this.providerStatus = providerStatus; this.status = status; this.code = code;
  }
}
export function json(data, status = 200) { return Response.json(data, { status, headers: { 'cache-control': 'no-store' } }); }
export async function fetchJson(url, options = {}, providerName = 'API') {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Number(process.env.API_TIMEOUT_MS || 10000)); let response;
  try { response = await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new ProviderError(`${providerName} timeout.`, { status: 504, code: 'TIMEOUT' });
    throw new ProviderError(`${providerName} request failed.`, { status: 502, code: 'NETWORK_ERROR' });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const status = response.status === 429 ? 503 : 502;
    const message = response.status === 429 ? `${providerName} rate limit byl překročen.` : `${providerName} HTTP ${response.status}.`;
    throw new ProviderError(message, { providerStatus: response.status, status, code: `HTTP_${response.status}` });
  }
  try { return { data: await response.json(), response }; }
  catch { throw new ProviderError(`${providerName} vrátilo neplatný JSON.`, { status: 502, code: 'INVALID_JSON' }); }
}
