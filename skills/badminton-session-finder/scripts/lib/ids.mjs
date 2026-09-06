import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function hashId(prefix, parts) {
  const input = parts.map((part) => typeof part === "string" ? part : stableStringify(part)).join("\u001f");
  return `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 20)}`;
}

export function createBatchId(batch) {
  return hashId("batch", [batch?.batch_id ?? "", batch?.group_id ?? "", batch?.group_url ?? "", batch]);
}

export function createPostId(batchId, sourcePostIndex, post) {
  const sourceIdentity = post?.post_id ?? post?.post_url ?? [post?.author_name, post?.published_time_raw, post?.content_text].filter(Boolean).join("\u001f");
  return hashId("post", [batchId, String(sourcePostIndex), sourceIdentity, post]);
}

export function createListingId(postId, listing) {
  return hashId("listing", [postId, String(listing.listing_index), listing.schedule, listing.venue]);
}
