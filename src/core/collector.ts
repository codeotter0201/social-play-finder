import { makeFingerprint } from "../shared/normalize";
import type { CardFailureReason, Post, Stats } from "../shared/types";
import { emptyStats } from "../shared/types";

export class PostCollector {
  readonly posts: Post[] = [];
  readonly stats: Stats = emptyStats();
  private readonly postIds = new Map<string, number>();
  private readonly postUrls = new Map<string, number>();
  private readonly fingerprints = new Set<string>();

  recordExcluded(): void { this.stats.scanned += 1; this.stats.excluded += 1; }
  recordFailed(reason: CardFailureReason): void {
    this.stats.scanned += 1;
    this.stats.failed += 1;
    this.stats.failed_by_reason[reason] += 1;
  }

  record(post: Post): "exported" | "duplicate" {
    this.stats.scanned += 1;
    const hasStableIdentity = Boolean(post.post_id || post.post_url);
    const fingerprint = makeFingerprint(post.author_name, post.published_time_raw, post.content_text);
    const idIndex = post.post_id ? this.postIds.get(post.post_id) : undefined;
    const urlIndex = post.post_url ? this.postUrls.get(post.post_url) : undefined;
    if (idIndex !== undefined && urlIndex !== undefined && idIndex !== urlIndex) {
      this.collapseStableRecords(idIndex, urlIndex, post);
      this.stats.duplicates += 2;
      this.stats.exported = this.posts.length;
      return "duplicate";
    }
    const stableIndex = idIndex ?? urlIndex;
    if (stableIndex !== undefined) {
      const index = stableIndex;
      this.posts[index] = mergeStablePost(this.posts[index], post);
      if (post.post_id) this.postIds.set(post.post_id, index);
      if (post.post_url) this.postUrls.set(post.post_url, index);
      this.stats.duplicates += 1;
      return "duplicate";
    }
    if (!hasStableIdentity && this.fingerprints.has(fingerprint)) {
      this.stats.duplicates += 1;
      return "duplicate";
    }
    const index = this.posts.push(post) - 1;
    if (post.post_id) this.postIds.set(post.post_id, index);
    if (post.post_url) this.postUrls.set(post.post_url, index);
    // Stable identities deliberately do not participate in fingerprint-only matching.
    if (!hasStableIdentity) this.fingerprints.add(fingerprint);
    this.stats.exported = this.posts.length;
    return "exported";
  }

  private collapseStableRecords(firstIndex: number, secondIndex: number, later: Post): void {
    const keep = Math.min(firstIndex, secondIndex);
    const remove = Math.max(firstIndex, secondIndex);
    this.posts[keep] = mergeStablePost(mergeStablePost(this.posts[keep], this.posts[remove]), later);
    this.posts.splice(remove, 1);
    remapAfterRemoval(this.postIds, keep, remove);
    remapAfterRemoval(this.postUrls, keep, remove);
    if (later.post_id) this.postIds.set(later.post_id, keep);
    if (later.post_url) this.postUrls.set(later.post_url, keep);
  }
}

function mergeStablePost(first: Post, later: Post): Post {
  const merged: Post = { ...first };
  if (merged.author_profile_url == null && later.author_profile_url != null && !merged.is_anonymous) merged.author_profile_url = later.author_profile_url;
  const fillOnlyKeys: (keyof Post)[] = [
    "post_id", "post_url", "author_name", "author_url", "is_anonymous", "published_time_raw", "published_at", "is_pinned",
  ];
  for (const key of fillOnlyKeys) {
    const value = later[key];
    if (merged[key] === null && value !== null) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  const latestMetricKeys: (keyof Post)[] = [
    "reaction_count_raw", "reaction_count", "comment_count_raw", "comment_count", "share_count_raw", "share_count",
  ];
  for (const key of latestMetricKeys) {
    const value = later[key];
    if (value !== null) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if ((first.content_is_truncated !== false && later.content_is_truncated === false) || (!first.content_text && later.content_text)) {
    merged.content_text = later.content_text;
    merged.content_is_truncated = false;
  }
  merged.media = uniqueMedia([...first.media, ...later.media]);
  merged.warnings = [...new Set([...first.warnings, ...later.warnings])].filter((warning) => !(warning === "content_truncated" && merged.content_is_truncated === false));
  merged.scraped_at = later.scraped_at;
  return merged;
}

function remapAfterRemoval(map: Map<string, number>, keep: number, remove: number): void {
  for (const [key, index] of map) {
    if (index === remove) map.set(key, keep);
    else if (index > remove) map.set(key, index - 1);
  }
}

function uniqueMedia(media: Post["media"]): Post["media"] {
  return media.filter((item, index) => media.findIndex((candidate) => candidate.type === item.type && candidate.url === item.url) === index);
}
