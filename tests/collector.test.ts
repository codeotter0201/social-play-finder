import { describe, expect, it } from "vitest";
import { PostCollector } from "../src/core/collector";
import type { Post } from "../src/shared/types";

function post(overrides: Partial<Post> = {}): Post {
  return {
    post_id: "1", post_url: "https://www.facebook.com/groups/g/posts/1/", author_name: "Author", author_url: null,
    is_anonymous: false, content_text: "short", content_is_truncated: true, published_time_raw: "3h", published_at: null,
    reaction_count_raw: null, reaction_count: null, comment_count_raw: null, comment_count: null, share_count_raw: null,
    share_count: null, media: [], is_pinned: null, scraped_at: "2026-08-30T00:00:00.000Z", warnings: ["content_truncated"], ...overrides,
  };
}

describe("PostCollector", () => {
  it("deduplicates stable identity and merges only reliable later observations", () => {
    const collector = new PostCollector();
    expect(collector.record(post())).toBe("exported");
    expect(collector.record(post({ content_text: "complete", content_is_truncated: false, reaction_count_raw: "5", reaction_count: 5, scraped_at: "2026-08-30T01:00:00.000Z", warnings: [] }))).toBe("duplicate");
    expect(collector.posts).toHaveLength(1);
    expect(collector.posts[0]).toMatchObject({ content_text: "complete", content_is_truncated: false, reaction_count: 5, scraped_at: "2026-08-30T01:00:00.000Z" });
    expect(collector.posts[0].warnings).not.toContain("content_truncated");
    expect(collector.stats).toEqual({
      scanned: 2, exported: 1, excluded: 0, duplicates: 1, failed: 0,
      failed_by_reason: { unknown_card: 0, minimum_data: 0, exception: 0 },
    });
  });

  it("does not merge fingerprint-only duplicates", () => {
    const collector = new PostCollector();
    const noIdentity = post({ post_id: null, post_url: null });
    collector.record(noIdentity);
    collector.record({ ...noIdentity, reaction_count: 99 });
    expect(collector.posts[0].reaction_count).toBeNull();
    expect(collector.stats.duplicates).toBe(1);
  });

  it("deduplicates when either a post ID or URL matches", () => {
    const collector = new PostCollector();
    collector.record(post({ post_id: "1", post_url: "https://www.facebook.com/groups/g/posts/1/" }));
    collector.record(post({ post_id: "2", post_url: "https://www.facebook.com/groups/g/posts/1/", reaction_count: 7 }));
    expect(collector.posts).toHaveLength(1);
    expect(collector.posts[0].reaction_count).toBe(7);
    expect(collector.stats.duplicates).toBe(1);
  });

  it("never replaces confirmed complete content with a later truncated view", () => {
    const collector = new PostCollector();
    collector.record(post({ content_text: "complete", content_is_truncated: false, warnings: [] }));
    collector.record(post({ content_text: "short", content_is_truncated: true }));
    expect(collector.posts[0]).toMatchObject({ content_text: "complete", content_is_truncated: false });
  });

  it("only fills missing stable fields while keeping later interaction observations", () => {
    const collector = new PostCollector();
    collector.record(post({ author_name: "First author", reaction_count: 1 }));
    collector.record(post({ author_name: "Different author", reaction_count: 2 }));
    expect(collector.posts[0]).toMatchObject({ author_name: "First author", reaction_count: 2 });
  });

  it("collapses records when a later observation bridges their ID and URL", () => {
    const collector = new PostCollector();
    collector.record(post({ post_id: "1", post_url: "https://www.facebook.com/groups/g/posts/1/" }));
    collector.record(post({ post_id: "2", post_url: "https://www.facebook.com/groups/g/posts/2/" }));
    collector.record(post({ post_id: "1", post_url: "https://www.facebook.com/groups/g/posts/2/" }));
    expect(collector.posts).toHaveLength(1);
    expect(collector.stats).toEqual({
      scanned: 3, exported: 1, excluded: 0, duplicates: 2, failed: 0,
      failed_by_reason: { unknown_card: 0, minimum_data: 0, exception: 0 },
    });
  });

  it("maintains the scanned classification invariant", () => {
    const collector = new PostCollector();
    collector.record(post()); collector.recordExcluded(); collector.recordFailed("exception");
    expect(collector.stats.scanned).toBe(collector.stats.exported + collector.stats.excluded + collector.stats.duplicates + collector.stats.failed);
    expect(collector.stats.failed_by_reason).toEqual({ unknown_card: 0, minimum_data: 0, exception: 1 });
  });
});
