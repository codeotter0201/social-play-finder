import type { BatchEnvelope, Post } from "../shared/types";

const BATCH_COLUMNS = [
  "batch_id", "batch_source", "batch_status", "batch_stop_reason",
  "batch_group_id", "batch_group_name", "batch_group_url", "batch_started_at", "batch_finished_at",
  "batch_target_post_count", "batch_no_new_scan_limit", "batch_card_delay_min_ms", "batch_card_delay_max_ms",
  "batch_scroll_delay_min_ms", "batch_scroll_delay_max_ms", "batch_no_new_backoff_step_ms", "batch_no_new_backoff_max_ms",
  "batch_scroll_distance_min_percent", "batch_scroll_distance_max_percent",
  "batch_max_duration_seconds", "batch_scanned", "batch_exported",
  "batch_excluded", "batch_duplicates", "batch_failed", "batch_failed_unknown_card",
  "batch_failed_minimum_data", "batch_failed_exception",
] as const;
const POST_COLUMNS: (keyof Post)[] = [
  "post_id", "post_url", "author_name", "author_url", "is_anonymous", "content_text", "content_is_truncated",
  "published_time_raw", "published_at", "reaction_count_raw", "reaction_count", "comment_count_raw", "comment_count",
  "share_count_raw", "share_count", "media", "is_pinned", "scraped_at", "warnings",
];
const NUMERIC_OR_BOOLEAN = new Set([
  "batch_target_post_count", "batch_no_new_scan_limit", "batch_card_delay_min_ms", "batch_card_delay_max_ms",
  "batch_scroll_delay_min_ms", "batch_scroll_delay_max_ms", "batch_no_new_backoff_step_ms", "batch_no_new_backoff_max_ms",
  "batch_scroll_distance_min_percent", "batch_scroll_distance_max_percent", "batch_max_duration_seconds",
  "batch_scanned", "batch_exported", "batch_excluded", "batch_duplicates", "batch_failed",
  "batch_failed_unknown_card", "batch_failed_minimum_data", "batch_failed_exception",
  "reaction_count", "comment_count", "share_count", "is_anonymous", "content_is_truncated", "is_pinned",
]);
const ISO_COLUMNS = new Set(["batch_started_at", "batch_finished_at", "published_at", "scraped_at"]);

export function serializeJson(envelope: BatchEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function serializeCsv(envelope: BatchEnvelope): string {
  const columns = [...BATCH_COLUMNS, ...POST_COLUMNS];
  const header = columns.map(csvEscape).join(",");
  const rows = envelope.posts.map((post) => {
    const batchValues: Record<(typeof BATCH_COLUMNS)[number], unknown> = {
      batch_id: envelope.batch.batch_id,
      batch_source: envelope.batch.source,
      batch_status: envelope.batch.status,
      batch_stop_reason: envelope.batch.stop_reason,
      batch_group_id: envelope.batch.group_id,
      batch_group_name: envelope.batch.group_name,
      batch_group_url: envelope.batch.group_url,
      batch_started_at: envelope.batch.started_at,
      batch_finished_at: envelope.batch.finished_at,
      batch_target_post_count: envelope.batch.target_post_count,
      batch_no_new_scan_limit: envelope.batch.no_new_scan_limit,
      batch_card_delay_min_ms: envelope.batch.pacing.card_delay_min_ms,
      batch_card_delay_max_ms: envelope.batch.pacing.card_delay_max_ms,
      batch_scroll_delay_min_ms: envelope.batch.pacing.scroll_delay_min_ms,
      batch_scroll_delay_max_ms: envelope.batch.pacing.scroll_delay_max_ms,
      batch_no_new_backoff_step_ms: envelope.batch.pacing.no_new_backoff_step_ms,
      batch_no_new_backoff_max_ms: envelope.batch.pacing.no_new_backoff_max_ms,
      batch_scroll_distance_min_percent: envelope.batch.pacing.scroll_distance_min_percent,
      batch_scroll_distance_max_percent: envelope.batch.pacing.scroll_distance_max_percent,
      batch_max_duration_seconds: envelope.batch.max_duration_seconds,
      batch_scanned: envelope.batch.stats.scanned,
      batch_exported: envelope.batch.stats.exported,
      batch_excluded: envelope.batch.stats.excluded,
      batch_duplicates: envelope.batch.stats.duplicates,
      batch_failed: envelope.batch.stats.failed,
      batch_failed_unknown_card: envelope.batch.stats.failed_by_reason.unknown_card,
      batch_failed_minimum_data: envelope.batch.stats.failed_by_reason.minimum_data,
      batch_failed_exception: envelope.batch.stats.failed_by_reason.exception,
    };
    return columns.map((column) => {
      const value = column in batchValues ? batchValues[column as keyof typeof batchValues] : post[column as keyof Post];
      const serialized = Array.isArray(value) ? JSON.stringify(value) : value == null ? "" : String(value);
      const safe = NUMERIC_OR_BOOLEAN.has(column) || ISO_COLUMNS.has(column) ? serialized : guardFormula(serialized);
      return csvEscape(safe);
    }).join(",");
  });
  return `\uFEFF${[header, ...rows].join("\r\n")}`;
}

function guardFormula(value: string): string {
  return /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;
}

function csvEscape(value: unknown): string {
  const string = String(value ?? "");
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

export function makeFilenameStem(envelope: BatchEnvelope, localDate = new Date(envelope.batch.started_at)): string {
  const slug = new URL(envelope.batch.group_url).pathname.split("/").filter(Boolean)[1] || "group";
  const safePart = (value: string) => value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, "-").slice(0, 60);
  const groupKey = [envelope.batch.group_name?.trim() ? safePart(envelope.batch.group_name.trim()) : null, safePart(envelope.batch.group_id || slug)].filter(Boolean).join("_") || "group";
  const pad = (number: number) => String(number).padStart(2, "0");
  const stamp = `${localDate.getFullYear()}-${pad(localDate.getMonth() + 1)}-${pad(localDate.getDate())}_${pad(localDate.getHours())}${pad(localDate.getMinutes())}${pad(localDate.getSeconds())}`;
  return `facebook-group_${groupKey}_${stamp}_${envelope.batch.batch_id.slice(0, 8)}`;
}
