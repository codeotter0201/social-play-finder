export type BatchStatus = "completed" | "stopped" | "failed";
export type StopReason =
  | "target_reached" | "no_new_posts"
  | "user_stopped" | "time_limit_reached" | "page_navigated" | "source_tab_closed"
  | "access_denied" | "facebook_blocked" | "dom_changed" | "fatal_error";

export type CardFailureReason = "unknown_card" | "minimum_data" | "exception";
export interface FailureReasonCounts { unknown_card: number; minimum_data: number; exception: number }
export interface Stats {
  scanned: number;
  exported: number;
  excluded: number;
  duplicates: number;
  failed: number;
  failed_by_reason: FailureReasonCounts;
}
export interface PacingSettings {
  cardDelayMinMs: number;
  cardDelayMaxMs: number;
  scrollDelayMinMs: number;
  scrollDelayMaxMs: number;
  noNewBackoffStepMs: number;
  noNewBackoffMaxMs: number;
  scrollDistanceMinPercent: number;
  scrollDistanceMaxPercent: number;
}
export interface BatchSettings { targetPostCount: number; maxDurationMinutes: number; noNewScanLimit: number; pacing: PacingSettings }
export interface PacingInfo {
  card_delay_min_ms: number;
  card_delay_max_ms: number;
  scroll_delay_min_ms: number;
  scroll_delay_max_ms: number;
  no_new_backoff_step_ms: number;
  no_new_backoff_max_ms: number;
  scroll_distance_min_percent: number;
  scroll_distance_max_percent: number;
}
export interface MediaItem { type: "image" | "video" | "link" | "unknown"; url: string | null }
export interface Post {
  post_id: string | null;
  post_url: string | null;
  author_name: string | null;
  author_url: string | null;
  /** Direct profile link derived from author_url; optional for older exports. */
  author_profile_url?: string | null;
  is_anonymous: boolean | null;
  content_text: string;
  content_is_truncated: boolean | null;
  published_time_raw: string | null;
  published_at: string | null;
  reaction_count_raw: string | null;
  reaction_count: number | null;
  comment_count_raw: string | null;
  comment_count: number | null;
  share_count_raw: string | null;
  share_count: number | null;
  media: MediaItem[];
  is_pinned: boolean | null;
  scraped_at: string;
  warnings: string[];
}
export interface BatchInfo {
  batch_id: string;
  source: "facebook_group";
  status: BatchStatus;
  stop_reason: StopReason;
  group_id: string | null;
  group_name: string | null;
  group_url: string;
  target_post_count: number;
  no_new_scan_limit: number;
  pacing: PacingInfo;
  max_duration_seconds: number | null;
  started_at: string;
  finished_at: string;
  stats: Stats;
}
export interface BatchEnvelope { batch: BatchInfo; posts: Post[] }

export type Phase = "preflight" | "scanning" | "scrolling" | "waiting_for_foreground";
export interface ActiveBatch {
  batchId: string;
  tabId: number;
  groupName: string | null;
  groupUrl: string;
  phase: Phase;
  settings: BatchSettings;
  startedAt: string;
  stats: Stats;
  noNewCount: number;
}
export interface SessionState { active: ActiveBatch | null; result: BatchEnvelope | null; resultHandled: boolean; lastError: PreflightCode | null }

export type PreflightCode = "unsupported_page" | "not_logged_in" | "access_denied" | "dom_changed";
export type Message =
  | { type: "GET_STATE" }
  | { type: "PREPARE_START"; batchId: string; tabId: number; tabUrl: string; settings: BatchSettings; replaceResult: boolean }
  | { type: "START_BATCH"; batchId: string; settings: BatchSettings }
  | { type: "STOP_BATCH" }
  | { type: "RUNNER_STARTED"; active: ActiveBatch }
  | { type: "RUNNER_PROGRESS"; active: ActiveBatch; partial: BatchEnvelope }
  | { type: "RUNNER_FINISHED"; result: BatchEnvelope }
  | { type: "RUNNER_PREFLIGHT_FAILED"; code: PreflightCode; excludedCount?: number }
  | { type: "CANCEL_PREPARE"; batchId: string }
  | { type: "DISCARD_RESULT" }
  | { type: "MARK_RESULT_HANDLED" };

export interface AppResponse<T = unknown> { ok: boolean; data?: T; error?: string; code?: string }

export function emptyStats(): Stats {
  return {
    scanned: 0,
    exported: 0,
    excluded: 0,
    duplicates: 0,
    failed: 0,
    failed_by_reason: { unknown_card: 0, minimum_data: 0, exception: 0 },
  };
}
