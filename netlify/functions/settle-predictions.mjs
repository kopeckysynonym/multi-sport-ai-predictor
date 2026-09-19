import { settlePendingPredictions } from './lib/settlement.mjs';

export default async () => {
  const result = await settlePendingPredictions({ limit: 100 });
  console.log('Prediction Tracker settlement:', JSON.stringify(result));
};

export const config = {
  schedule: '@hourly'
};
