import { describe, expect, it } from "vitest";
import { facebookProfileUrl } from "../src/shared/facebook-profile.mjs";
import { parseCard } from "../src/core/parser";
import { serializeCsv, serializeJson } from "../src/core/export";
import { emptyStats, type BatchEnvelope } from "../src/shared/types";
import { DEFAULT_BATCH_SETTINGS, toPacingInfo } from "../src/core/settings";
import { readFileSync } from "node:fs";

describe("author profile URLs", () => {
  it.each([
    ["https://www.facebook.com/groups/100/user/90071992547409999/?__tn__=R", "https://www.facebook.com/profile.php?id=90071992547409999"],
    ["/groups/group.name/user/123/", "https://www.facebook.com/profile.php?id=123"],
    ["https://m.facebook.com/profile.php?id=123&ref=group", "https://www.facebook.com/profile.php?id=123"],
    ["https://www.facebook.com/people/Some-Name/123/", "https://www.facebook.com/profile.php?id=123"],
    ["https://facebook.com/123/", "https://www.facebook.com/profile.php?id=123"],
    ["https://www.facebook.com/Some.Name/?fbclid=tracking", "https://www.facebook.com/Some.Name"],
  ])("normalizes only the author link %s", (input, expected) => {
    expect(facebookProfileUrl(input)).toBe(expected);
  });
  it.each([
    null, "", "https://www.facebook.com/groups/100/", "https://www.facebook.com/groups/100/user/unknown/",
    "https://www.facebook.com/profile.php?id=abc", "https://www.facebook.com/profile.php?id=1&id=2",
    "https://www.facebook.com/share/abc/", "https://www.facebook.com/help", "https://www.facebook.com/settings/",
    "https://www.facebook.com/watch", "https://www.facebook.com/login.php", "https://www.facebook.com/photo.php?fbid=123",
    "https://www.facebook.com.evil.test/123", "https://example.com/123", "javascript:alert(1)", "https://user@facebook.com/123",
  ])("does not invent a profile from %s", input => { expect(facebookProfileUrl(input)).toBeNull(); });
  it("never resolves an anonymous author's profile", () => {
    expect(facebookProfileUrl("https://www.facebook.com/groups/100/user/123/", true)).toBeNull();
  });
  it.each([
    ["https://www.facebook.com/groups/100/user/123/", "https://www.facebook.com/profile.php?id=123"],
    ["https://www.facebook.com/Some.Name", "https://www.facebook.com/Some.Name"],
  ])("stores a separate profile field without replacing the source URL", (url, profile) => {
    document.documentElement.innerHTML = readFileSync("tests/fixtures/group-feed-zh.html", "utf8");
    const author = document.querySelector<HTMLAnchorElement>("[data-fbgpe-author]")!;
    author.href = url;
    const post = parseCard(author.closest('[data-fbgpe-card]')!, "https://www.facebook.com/groups/100/")!;
    expect(post.author_url).toBe(url);
    expect(post.author_profile_url).toBe(profile);
    const envelope: BatchEnvelope = { batch: {
      batch_id: "test", source: "facebook_group", status: "completed", stop_reason: "target_reached",
      group_id: "100", group_name: "Test", group_url: "https://www.facebook.com/groups/100/",
      started_at: "2026-09-06T00:00:00Z", finished_at: "2026-09-06T00:01:00Z",
      target_post_count: 5, no_new_scan_limit: 10, max_duration_seconds: 1800,
      pacing: toPacingInfo(DEFAULT_BATCH_SETTINGS.pacing), stats: emptyStats(),
    }, posts:[post] };
    expect(JSON.parse(serializeJson(envelope)).posts[0].author_profile_url).toBe(profile);
    const csv=serializeCsv(envelope);
    expect(csv.split('\r\n')[0]).toContain('author_profile_url');
    expect(csv).toContain(profile);
  });
});
