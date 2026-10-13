/**
 * Queue time estimates. These are estimates from the shop's own recent
 * throughput, never a promise and never live device telemetry.
 */
export interface ThroughputSample {
  /** Sheets in a completed job. */
  sheets: number;
  /** Seconds from PRINTING to READY_FOR_PICKUP. */
  productionSeconds: number;
}

export interface QueueEstimate {
  /** Jobs ahead in the queue, not counting this one. */
  jobsAhead: number;
  sheetsAhead: number;
  /** Rounded up to 5 minutes; null when there is not enough history. */
  estimatedMinutes: number | null;
  basis: "SHOP_HISTORY" | "INSUFFICIENT_HISTORY";
}

export const MIN_SAMPLES_FOR_ESTIMATE = 5;
/** Used for jobs with no throughput data: fixed handling overhead per job. */
const PER_JOB_OVERHEAD_SECONDS = 60;

/** Median seconds per sheet across recent jobs; robust to the odd stalled job. */
export function secondsPerSheet(samples: readonly ThroughputSample[]): number | null {
  const rates = samples
    .filter((s) => s.sheets > 0 && s.productionSeconds > 0)
    .map((s) => s.productionSeconds / s.sheets)
    .sort((a, b) => a - b);
  if (rates.length < MIN_SAMPLES_FOR_ESTIMATE) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}

export function estimateQueue(params: {
  sheetsAheadPerJob: readonly number[];
  ownSheets: number;
  samples: readonly ThroughputSample[];
  activeDevices: number;
}): QueueEstimate {
  const sheetsAhead = params.sheetsAheadPerJob.reduce((a, b) => a + b, 0);
  const rate = secondsPerSheet(params.samples);
  if (rate === null) {
    return { jobsAhead: params.sheetsAheadPerJob.length, sheetsAhead, estimatedMinutes: null, basis: "INSUFFICIENT_HISTORY" };
  }
  const devices = Math.max(1, params.activeDevices);
  const jobs = params.sheetsAheadPerJob.length + 1;
  const seconds = ((sheetsAhead + params.ownSheets) * rate + jobs * PER_JOB_OVERHEAD_SECONDS) / devices;
  const minutes = Math.max(5, Math.ceil(seconds / 60 / 5) * 5);
  return { jobsAhead: params.sheetsAheadPerJob.length, sheetsAhead, estimatedMinutes: minutes, basis: "SHOP_HISTORY" };
}
