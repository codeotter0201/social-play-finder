import type { Post } from "../shared/types";

export function renderPostPreview(root: HTMLElement, posts: Post[]): void {
  const openKeys = new Set(
    [...root.querySelectorAll<HTMLDetailsElement>("details[open]")]
      .map((details) => details.dataset.postKey)
      .filter((key): key is string => Boolean(key)),
  );

  root.replaceChildren(...posts.slice(0, 10).map((post, index) => {
    const key = post.post_id || post.post_url || String(index);
    const details = document.createElement("details");
    details.dataset.postKey = key;
    details.open = openKeys.has(key);
    const summary = document.createElement("summary");
    summary.textContent = `${index + 1}. ${post.author_name || "作者缺失"} — ${post.content_text.slice(0, 45) || "媒體貼文"}`;
    if (post.post_url) {
      const link = document.createElement("a");
      link.href = post.post_url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "開啟原貼文";
      details.append(summary, link);
    } else {
      details.append(summary);
    }
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(post, null, 2);
    details.append(pre);
    return details;
  }));
}
