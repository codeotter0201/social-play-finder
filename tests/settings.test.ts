import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_SETTINGS, batchSettingsEqual, parseBatchSettings, parseStoredBatchSettings } from "../src/core/settings";

describe("batch settings", () => {
  it("uses five posts and ten no-new scan rounds by default", () => {
    expect(DEFAULT_BATCH_SETTINGS.targetPostCount).toBe(5);
    expect(DEFAULT_BATCH_SETTINGS.maxDurationMinutes).toBe(30);
    expect(DEFAULT_BATCH_SETTINGS.noNewScanLimit).toBe(10);
    expect(DEFAULT_BATCH_SETTINGS.pacing).toEqual({
      cardDelayMinMs: 100,
      cardDelayMaxMs: 250,
      scrollDelayMinMs: 500,
      scrollDelayMaxMs: 900,
      noNewBackoffStepMs: 300,
      noNewBackoffMaxMs: 1_500,
      scrollDistanceMinPercent: 70,
      scrollDistanceMaxPercent: 95,
    });
    expect(parseBatchSettings(DEFAULT_BATCH_SETTINGS)).toEqual(DEFAULT_BATCH_SETTINGS);
  });

  it("migrates the previous untouched pacing defaults", () => {
    const stored = {
      ...DEFAULT_BATCH_SETTINGS,
      targetPostCount: 200,
      pacing: {
        cardDelayMinMs: 350,
        cardDelayMaxMs: 700,
        scrollDelayMinMs: 2_200,
        scrollDelayMaxMs: 3_600,
        noNewBackoffStepMs: 800,
        noNewBackoffMaxMs: 4_000,
        scrollDistanceMinPercent: 45,
        scrollDistanceMaxPercent: 75,
      },
    };
    expect(parseStoredBatchSettings(stored)).toEqual({
      ...stored,
      pacing: DEFAULT_BATCH_SETTINGS.pacing,
    });
  });

  it("migrates the immediately previous faster pacing defaults", () => {
    const stored = {
      ...DEFAULT_BATCH_SETTINGS,
      pacing: {
        cardDelayMinMs: 100,
        cardDelayMaxMs: 250,
        scrollDelayMinMs: 700,
        scrollDelayMaxMs: 1_200,
        noNewBackoffStepMs: 300,
        noNewBackoffMaxMs: 1_500,
        scrollDistanceMinPercent: 70,
        scrollDistanceMaxPercent: 95,
      },
    };
    expect(parseStoredBatchSettings(stored)?.pacing).toEqual(DEFAULT_BATCH_SETTINGS.pacing);
  });

  it("accepts customized settings inside the safe ranges", () => {
    const settings = {
      ...DEFAULT_BATCH_SETTINGS,
      targetPostCount: 25,
      maxDurationMinutes: 60,
      noNewScanLimit: 20,
      pacing: { ...DEFAULT_BATCH_SETTINGS.pacing, cardDelayMinMs: 500, cardDelayMaxMs: 800, scrollDistanceMaxPercent: 90 },
    };
    const parsed = parseBatchSettings(settings);
    expect(parsed).toEqual(settings);
    expect(batchSettingsEqual(parsed!, settings)).toBe(true);
  });

  it("rejects unsafe ranges and inverted minimums", () => {
    expect(parseBatchSettings({ ...DEFAULT_BATCH_SETTINGS, noNewScanLimit: 0 })).toBeNull();
    expect(parseBatchSettings({ ...DEFAULT_BATCH_SETTINGS, noNewScanLimit: 101 })).toBeNull();
    expect(parseBatchSettings({ ...DEFAULT_BATCH_SETTINGS, maxDurationMinutes: 0 })).toBeNull();
    expect(parseBatchSettings({ ...DEFAULT_BATCH_SETTINGS, maxDurationMinutes: 1_441 })).toBeNull();
    expect(parseBatchSettings({
      ...DEFAULT_BATCH_SETTINGS,
      pacing: { ...DEFAULT_BATCH_SETTINGS.pacing, cardDelayMinMs: 50 },
    })).toBeNull();
    expect(parseBatchSettings({
      ...DEFAULT_BATCH_SETTINGS,
      pacing: { ...DEFAULT_BATCH_SETTINGS.pacing, scrollDelayMinMs: 5_000, scrollDelayMaxMs: 2_000 },
    })).toBeNull();
  });
});
