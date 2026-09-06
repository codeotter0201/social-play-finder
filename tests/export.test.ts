import { describe, expect, it } from "vitest";
import { makeFilenameStem, serializeCsv, serializeJson } from "../src/core/export";
import { DEFAULT_BATCH_SETTINGS, toPacingInfo } from "../src/core/settings";
import type { BatchEnvelope } from "../src/shared/types";

const envelope: BatchEnvelope = {
  batch: {
    batch_id: "12345678-abcd-4000-8000-123456789abc", source: "facebook_group", status: "completed",
    stop_reason: "target_reached", group_id: "100", group_name: "測試/社團", group_url: "https://www.facebook.com/groups/100/",
    target_post_count: 5, no_new_scan_limit: 10, pacing: toPacingInfo(DEFAULT_BATCH_SETTINGS.pacing),
    max_duration_seconds: 1800, started_at: "2026-08-30T01:00:00.000Z", finished_at: "2026-08-30T02:03:04.000Z",
    stats: {
      scanned: 1, exported: 1, excluded: 0, duplicates: 0, failed: 0,
      failed_by_reason: { unknown_card: 0, minimum_data: 0, exception: 0 },
    },
  },
  posts: [{
    post_id: "1", post_url: "https://www.facebook.com/groups/100/posts/1/", author_name: "+danger", author_url: null,
    is_anonymous: false, content_text: "中文, \"quoted\"\n=SUM(A1:A2)", content_is_truncated: false, published_time_raw: "昨天",
    published_at: null, reaction_count_raw: "1.2 萬", reaction_count: 12000, comment_count_raw: null, comment_count: null,
    share_count_raw: null, share_count: null, media: [{ type: "image", url: "https://example.test/a.jpg" }], is_pinned: false,
    scraped_at: "2026-08-30T01:01:00.000Z", warnings: ["published_time_not_normalized"],
  }],
};

describe("exports", () => {
  it("preserves the canonical JSON envelope", () => {
    expect(JSON.parse(serializeJson(envelope))).toEqual(envelope);
    expect(serializeJson(envelope)).not.toContain("schema_version");
  });

  it("writes BOM, RFC 4180 fields, nested JSON and formula-safe text", () => {
    const csv = serializeCsv(envelope);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("'+danger");
    expect(csv).toContain('"中文, ""quoted""\n=SUM(A1:A2)"');
    expect(csv).toContain('"[{""type"":""image"",""url"":""https://example.test/a.jpg""}]"');
    expect(csv).toContain("batch_no_new_scan_limit");
    expect(csv).toContain("batch_scroll_distance_max_percent");
    expect(csv).toContain("batch_failed_minimum_data");
    expect(csv).not.toContain("schema_version");
    expect(csv).toContain(",12000,");
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("uses a shared safe filename stem", () => {
    const date = new Date(2026, 7, 30, 10, 11, 12);
    expect(makeFilenameStem(envelope)).toBe(makeFilenameStem(envelope, new Date(envelope.batch.started_at)));
    expect(makeFilenameStem(envelope, date)).toBe("facebook-group_測試-社團_100_2026-08-30_101112_12345678");
  });
});
