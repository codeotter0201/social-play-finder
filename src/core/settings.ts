import type { BatchSettings, PacingInfo, PacingSettings } from "../shared/types";

export const DEFAULT_BATCH_SETTINGS: Readonly<BatchSettings> = Object.freeze({
  targetPostCount: 5,
  maxDurationMinutes: 30,
  noNewScanLimit: 10,
  pacing: Object.freeze({
    cardDelayMinMs: 100,
    cardDelayMaxMs: 250,
    scrollDelayMinMs: 500,
    scrollDelayMaxMs: 900,
    noNewBackoffStepMs: 300,
    noNewBackoffMaxMs: 1_500,
    scrollDistanceMinPercent: 70,
    scrollDistanceMaxPercent: 95,
  }),
});

const PREVIOUS_DEFAULT_PACING: readonly Readonly<PacingSettings>[] = [
  Object.freeze({
    cardDelayMinMs: 350,
    cardDelayMaxMs: 700,
    scrollDelayMinMs: 2_200,
    scrollDelayMaxMs: 3_600,
    noNewBackoffStepMs: 800,
    noNewBackoffMaxMs: 4_000,
    scrollDistanceMinPercent: 45,
    scrollDistanceMaxPercent: 75,
  }),
  Object.freeze({
    cardDelayMinMs: 100,
    cardDelayMaxMs: 250,
    scrollDelayMinMs: 700,
    scrollDelayMaxMs: 1_200,
    noNewBackoffStepMs: 300,
    noNewBackoffMaxMs: 1_500,
    scrollDistanceMinPercent: 70,
    scrollDistanceMaxPercent: 95,
  }),
];

export function parseBatchSettings(value: unknown): BatchSettings | null {
  if (!isRecord(value) || !isRecord(value.pacing)) return null;
  const pacing = value.pacing;
  const settings: BatchSettings = {
    targetPostCount: value.targetPostCount as number,
    maxDurationMinutes: value.maxDurationMinutes as number,
    noNewScanLimit: value.noNewScanLimit as number,
    pacing: {
      cardDelayMinMs: pacing.cardDelayMinMs as number,
      cardDelayMaxMs: pacing.cardDelayMaxMs as number,
      scrollDelayMinMs: pacing.scrollDelayMinMs as number,
      scrollDelayMaxMs: pacing.scrollDelayMaxMs as number,
      noNewBackoffStepMs: pacing.noNewBackoffStepMs as number,
      noNewBackoffMaxMs: pacing.noNewBackoffMaxMs as number,
      scrollDistanceMinPercent: pacing.scrollDistanceMinPercent as number,
      scrollDistanceMaxPercent: pacing.scrollDistanceMaxPercent as number,
    },
  };
  if (!positiveSafeInteger(settings.targetPostCount) || !boundedInteger(settings.maxDurationMinutes, 1, 1_440) || !boundedInteger(settings.noNewScanLimit, 1, 100)) return null;
  if (!boundedInteger(settings.pacing.cardDelayMinMs, 100, 60_000) || !boundedInteger(settings.pacing.cardDelayMaxMs, 100, 60_000)) return null;
  if (!boundedInteger(settings.pacing.scrollDelayMinMs, 500, 120_000) || !boundedInteger(settings.pacing.scrollDelayMaxMs, 500, 120_000)) return null;
  if (!boundedInteger(settings.pacing.noNewBackoffStepMs, 0, 60_000) || !boundedInteger(settings.pacing.noNewBackoffMaxMs, 0, 300_000)) return null;
  if (!boundedInteger(settings.pacing.scrollDistanceMinPercent, 10, 100) || !boundedInteger(settings.pacing.scrollDistanceMaxPercent, 10, 100)) return null;
  if (settings.pacing.cardDelayMinMs > settings.pacing.cardDelayMaxMs) return null;
  if (settings.pacing.scrollDelayMinMs > settings.pacing.scrollDelayMaxMs) return null;
  if (settings.pacing.noNewBackoffStepMs > settings.pacing.noNewBackoffMaxMs) return null;
  if (settings.pacing.scrollDistanceMinPercent > settings.pacing.scrollDistanceMaxPercent) return null;
  return settings;
}

export function parseStoredBatchSettings(value: unknown): BatchSettings | null {
  const settings = parseBatchSettings(value);
  if (!settings || !PREVIOUS_DEFAULT_PACING.some((pacing) => pacingSettingsEqual(settings.pacing, pacing))) return settings;
  return { ...settings, pacing: { ...DEFAULT_BATCH_SETTINGS.pacing } };
}

export function batchSettingsEqual(left: BatchSettings, right: BatchSettings): boolean {
  return left.targetPostCount === right.targetPostCount
    && left.maxDurationMinutes === right.maxDurationMinutes
    && left.noNewScanLimit === right.noNewScanLimit
    && pacingSettingsEqual(left.pacing, right.pacing);
}

export function toPacingInfo(settings: PacingSettings): PacingInfo {
  return {
    card_delay_min_ms: settings.cardDelayMinMs,
    card_delay_max_ms: settings.cardDelayMaxMs,
    scroll_delay_min_ms: settings.scrollDelayMinMs,
    scroll_delay_max_ms: settings.scrollDelayMaxMs,
    no_new_backoff_step_ms: settings.noNewBackoffStepMs,
    no_new_backoff_max_ms: settings.noNewBackoffMaxMs,
    scroll_distance_min_percent: settings.scrollDistanceMinPercent,
    scroll_distance_max_percent: settings.scrollDistanceMaxPercent,
  };
}

function pacingSettingsEqual(left: PacingSettings, right: PacingSettings): boolean {
  return left.cardDelayMinMs === right.cardDelayMinMs
    && left.cardDelayMaxMs === right.cardDelayMaxMs
    && left.scrollDelayMinMs === right.scrollDelayMinMs
    && left.scrollDelayMaxMs === right.scrollDelayMaxMs
    && left.noNewBackoffStepMs === right.noNewBackoffStepMs
    && left.noNewBackoffMaxMs === right.noNewBackoffMaxMs
    && left.scrollDistanceMinPercent === right.scrollDistanceMinPercent
    && left.scrollDistanceMaxPercent === right.scrollDistanceMaxPercent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
