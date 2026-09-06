import type { PacingSettings } from "../shared/types";

export function cardPacingDelay(settings: PacingSettings, random: () => number = Math.random): number {
  return jitter(settings.cardDelayMinMs, settings.cardDelayMaxMs, random);
}

export function scanPacingDelay(noNewCount: number, settings: PacingSettings, random: () => number = Math.random): number {
  const backoff = Math.min(Math.max(noNewCount, 0) * settings.noNewBackoffStepMs, settings.noNewBackoffMaxMs);
  return jitter(settings.scrollDelayMinMs, settings.scrollDelayMaxMs, random) + backoff;
}

export function scrollDistance(viewportHeight: number, settings: PacingSettings, random: () => number = Math.random): number {
  const minimum = settings.scrollDistanceMinPercent / 100;
  const fraction = minimum + boundedRandom(random) * ((settings.scrollDistanceMaxPercent / 100) - minimum);
  return Math.max(1, Math.floor(Math.max(viewportHeight, 1) * fraction));
}

function jitter(minimum: number, maximum: number, random: () => number): number {
  return minimum + Math.floor(boundedRandom(random) * (maximum - minimum + 1));
}

function boundedRandom(random: () => number): number {
  return Math.min(Math.max(random(), 0), 0.999_999);
}
