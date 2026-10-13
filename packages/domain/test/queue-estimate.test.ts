import { describe, expect, it } from "vitest";
import { estimateQueue, secondsPerSheet } from "../src/index.js";

const samples = (n: number, secs: number) => Array.from({ length: n }, () => ({ sheets: 10, productionSeconds: secs }));

describe("queue estimates", () => {
  it("refuses to estimate without enough history", () => {
    expect(secondsPerSheet(samples(4, 100))).toBeNull();
    const e = estimateQueue({ sheetsAheadPerJob: [10, 20], ownSheets: 5, samples: samples(2, 100), activeDevices: 1 });
    expect(e).toEqual({ jobsAhead: 2, sheetsAhead: 30, estimatedMinutes: null, basis: "INSUFFICIENT_HISTORY" });
  });

  it("uses the median rate, robust to outliers", () => {
    const s = [...samples(5, 100), { sheets: 10, productionSeconds: 100_000 }];
    expect(secondsPerSheet(s)).toBe(10);
  });

  it("scales with devices and rounds up to 5 minutes", () => {
    const one = estimateQueue({ sheetsAheadPerJob: [100, 100], ownSheets: 100, samples: samples(5, 100), activeDevices: 1 });
    // (300 sheets * 10s + 3 jobs * 60s) / 1 = 3180s = 53 min -> 55
    expect(one.estimatedMinutes).toBe(55);
    const two = estimateQueue({ sheetsAheadPerJob: [100, 100], ownSheets: 100, samples: samples(5, 100), activeDevices: 2 });
    expect(two.estimatedMinutes).toBe(30);
  });

  it("never estimates below 5 minutes", () => {
    expect(estimateQueue({ sheetsAheadPerJob: [], ownSheets: 1, samples: samples(5, 10), activeDevices: 3 }).estimatedMinutes).toBe(5);
  });
});
