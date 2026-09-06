import { describe, expect, it } from "vitest";
import { renderPostPreview } from "../src/popup/preview";
import type { Post } from "../src/shared/types";

const post: Post = {
  post_id: "1", post_url: "https://www.facebook.com/groups/1/posts/1/", author_name: "Author", author_url: null,
  is_anonymous: false, content_text: "content", content_is_truncated: false, published_time_raw: null, published_at: null,
  reaction_count_raw: null, reaction_count: null, comment_count_raw: null, comment_count: null, share_count_raw: null,
  share_count: null, media: [], is_pinned: null, scraped_at: "2026-08-30T00:00:00.000Z", warnings: [],
};

describe("popup result preview", () => {
  it("preserves expanded posts across polling renders and exposes the original post", () => {
    const root = document.createElement("div");
    renderPostPreview(root, [post]);
    root.querySelector("details")!.open = true;

    renderPostPreview(root, [post]);

    expect(root.querySelector("details")!.open).toBe(true);
    expect(root.querySelector<HTMLAnchorElement>("a")?.href).toBe(post.post_url);
  });
});
