import { describe, expect, it } from "vitest";
import {
  cardPacingDelay,
  scanPacingDelay,
  scrollDistance,
} from "../src/core/pacing";
import { DEFAULT_BATCH_SETTINGS } from "../src/core/settings";

describe("low-impact collection pacing", () => {
  it("uses bounded jitter and backs off after scans without new posts", () => {
    const settings = DEFAULT_BATCH_SETTINGS.pacing;
    expect(scanPacingDelay(0, settings, () => 0)).toBe(500);
    expect(scanPacingDelay(0, settings, () => 0.999)).toBeLessThanOrEqual(900);
    expect(scanPacingDelay(4, settings, () => 0)).toBeGreaterThan(scanPacingDelay(0, settings, () => 0.999));
    expect(scanPacingDelay(20, settings, () => 0)).toBe(2_000);
    expect(cardPacingDelay(settings, () => 0)).toBe(100);
    expect(cardPacingDelay(settings, () => 0.999)).toBeLessThanOrEqual(250);
  });

  it("keeps each scroll smaller than one viewport", () => {
    const settings = DEFAULT_BATCH_SETTINGS.pacing;
    expect(scrollDistance(1_000, settings, () => 0)).toBe(700);
    expect(scrollDistance(1_000, settings, () => 0.999)).toBeLessThanOrEqual(950);
    const shorter = { ...settings, scrollDistanceMinPercent: 10, scrollDistanceMaxPercent: 20 };
    expect(scrollDistance(1_000, shorter, () => 0)).toBe(100);
    expect(scrollDistance(1_000, shorter, () => 0.999)).toBeLessThanOrEqual(200);
  });
});
