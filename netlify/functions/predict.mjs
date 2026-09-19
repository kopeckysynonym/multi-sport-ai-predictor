import { json } from './lib/http.mjs';
import { predictMatch } from './lib/predictor.mjs';
import { savePredictionSnapshot, updatePredictionSnapshot } from './lib/tracker.mjs';
import { syncPredictionSnapshotToSharePoint } from './lib/sharepoint-sync.mjs';
export default async request => {
  if (request.method !== 'POST') return json({ error: 'Použij POST.' }, 405);
  try {
    const body = await request.json();
    const result = await predictMatch(body.sport, body.team_a, body.team_b, body.odds || null, body.fixture || null);
    let tracker;
    try {
      tracker = await savePredictionSnapshot(result, body.fixture || null);

      if (tracker?.saved && tracker?.snapshot) {
        try {
          const sharepoint = await syncPredictionSnapshotToSharePoint(tracker.snapshot);
          const snapshotWithSync = {
            ...tracker.snapshot,
            sharepoint_sync: {
              status: sharepoint.synced ? 'SYNCED' : 'SKIPPED',
              created: sharepoint.created ?? null,
              duplicate: sharepoint.duplicate ?? null,
              item_id: sharepoint.item_id ?? null,
              reason: sharepoint.reason ?? null,
              synced_at: new Date().toISOString(),
            },
          };
          await updatePredictionSnapshot(tracker.key, snapshotWithSync);
          tracker = {
            ...tracker,
            snapshot: snapshotWithSync,
            sharepoint,
          };
        } catch (sharePointError) {
          console.warn('SharePoint prediction sync failed:', sharePointError.message);
          const snapshotWithSyncError = {
            ...tracker.snapshot,
            sharepoint_sync: {
              status: 'FAILED',
              code: sharePointError.code || 'SHAREPOINT_SYNC_FAILED',
              message: sharePointError.message,
              graph_status: sharePointError?.details?.graph_status ?? null,
              failed_at: new Date().toISOString(),
            },
          };
          try {
            await updatePredictionSnapshot(tracker.key, snapshotWithSyncError);
          } catch (persistError) {
            console.warn('SharePoint sync diagnostic persist failed:', persistError.message);
          }
          tracker = {
            ...tracker,
            snapshot: snapshotWithSyncError,
            sharepoint: {
              synced: false,
              reason: sharePointError.code || 'SHAREPOINT_SYNC_FAILED',
              message: sharePointError.message,
              graph_status: sharePointError?.details?.graph_status ?? null,
            },
          };
        }
      }
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
