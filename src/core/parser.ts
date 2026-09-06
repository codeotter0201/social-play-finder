import { cleanText, normalizeAbsoluteTime, normalizeCount } from "../shared/normalize";
import { DOM_RULES, TEXT_SIGNALS } from "../shared/rules";
import type { MediaItem, Post } from "../shared/types";
import { extractPostId, normalizeUrl, parseGroupSource } from "../shared/url";

export type CardKind = "supported" | "excluded" | "ignored" | "unknown";

function first(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

function containsAny(value: string, signals: readonly string[]): boolean {
  const folded = value.toLocaleLowerCase();
  return signals.some((signal) => folded.includes(signal.toLocaleLowerCase()));
}

function attributeOrText(element: Element | null, attribute: string): string | null {
  if (!element) return null;
  return cleanText(element.getAttribute(attribute) || element.textContent) || null;
}

export function findCards(document: Document): Element[] {
  const found = new Set<Element>();
  for (const selector of DOM_RULES.cards) document.querySelectorAll(selector).forEach((card) => found.add(card));
  document.querySelectorAll('[data-ad-rendering-role="story_message"], [data-ad-rendering-role="profile_name"]').forEach((marker) => {
    const card = marker.closest("[data-virtualized]");
    if (card) found.add(card);
  });
  const candidates = [...found].filter((card) => !card.closest("[data-commentid]"));
  return candidates.filter((card) => !candidates.some((parent) => parent !== card && parent.contains(card)));
}

export function classifyCard(card: Element): CardKind {
  const explicit = card.getAttribute("data-fbgpe-kind");
  if (explicit === "supported" || explicit === "excluded" || explicit === "ignored" || explicit === "unknown") return explicit;
  const typeText = cardTypeText(card);
  if (containsAny(typeText, TEXT_SIGNALS.ignoredProgress)) return "ignored";
  if (containsAny(typeText, TEXT_SIGNALS.excluded)) return "excluded";
  if (first(card, DOM_RULES.content) || findPostPermalink(card)) return "supported";
  return hasPostEvidence(card) ? "unknown" : "ignored";
}

function hasPostEvidence(card: Element): boolean {
  return Boolean(
    first(card, DOM_RULES.author)
    || first(card, DOM_RULES.time)
    || card.querySelector('a[href*="set=pcb."], img[src], video[src], video[poster]'),
  );
}

function cardTypeText(card: Element): string {
  const labels = [card.getAttribute("aria-label")];
  card.querySelectorAll("[data-fbgpe-card-label], [role='heading']").forEach((element) => {
    labels.push(element.getAttribute("aria-label") || element.textContent);
  });
  return cleanText(labels.filter(Boolean).join("\n"));
}

export function isProgressCard(kind: CardKind): boolean {
  return kind === "supported" || kind === "excluded" || kind === "unknown";
}

function parseMedia(card: Element, baseUrl: string): MediaItem[] {
  const media: MediaItem[] = [];
  const contentRoot = card.querySelector("[data-fbgpe-attachments], [data-fbgpe-content-area]") ?? card;
  for (const element of contentRoot.querySelectorAll("img[src], video[src], video[poster], a[href]")) {
    if (element.closest("[data-fbgpe-author], [data-fbgpe-comments], [data-commentid]")) continue;
    if (element.closest('a[href*="/user/"], a[href*="profile.php"]')) continue;
    let type: MediaItem["type"];
    let raw: string | null;
    if (element instanceof HTMLImageElement) { type = "image"; raw = element.getAttribute("src"); }
    else if (element instanceof HTMLVideoElement) { type = "video"; raw = element.getAttribute("src") || element.getAttribute("poster"); }
    else {
      const href = element.getAttribute("href");
      if (!href) continue;
      type = "link"; raw = href;
    }
    const url = normalizeUrl(raw, baseUrl);
    if (!url) continue;
    if (type === "link" && new URL(url).hostname.endsWith("facebook.com")) continue;
    if (!media.some((item) => item.type === type && item.url === url)) media.push({ type, url });
  }
  for (const unknown of contentRoot.querySelectorAll("[data-fbgpe-attachment='unknown']")) {
    const url = normalizeUrl(unknown.getAttribute("data-url"), baseUrl);
    if (!media.some((item) => item.type === "unknown" && item.url === url)) media.push({ type: "unknown", url });
  }
  return media;
}

function findMetric(card: Element, name: "reaction" | "comment" | "share"): string | null {
  const explicit = card.querySelector(`[data-fbgpe-${name}-count]`);
  if (explicit) return attributeOrText(explicit, `data-fbgpe-${name}-count`);
  const patterns = name === "reaction"
    ? [/([\d,.]+\s*(?:萬|万|[KkMm])?)\s*(?:個?讚|次?心情|reactions?|likes?)/i]
    : name === "comment"
      ? [/([\d,.]+\s*(?:萬|万|[KkMm])?)\s*(?:則?留言|comments?)/i]
      : [/([\d,.]+\s*(?:萬|万|[KkMm])?)\s*(?:次?分享|shares?)/i];
  const text = cleanText(card.textContent);
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function findSeeMore(card: Element): HTMLElement | null {
  const content = first(card, DOM_RULES.content);
  if (!content) return null;
  const scope = content.parentElement ?? content;
  for (const selector of DOM_RULES.seeMore) {
    for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest("[data-fbgpe-comments], [aria-label*='留言'], [aria-label*='comment' i]")) continue;
      const label = cleanText(element.textContent || element.getAttribute("aria-label"));
      if (TEXT_SIGNALS.seeMore.some((signal) => label.toLocaleLowerCase() === signal.toLocaleLowerCase())) return element;
    }
  }
  return null;
}

export function parseCard(card: Element, baseUrl: string, scrapedAt = new Date().toISOString()): Post | null {
  const permalink = findPostPermalink(card);
  let postUrl = normalizeUrl(permalink?.getAttribute("href"), baseUrl);
  const explicitId = card.getAttribute("data-fbgpe-post-id");
  const postId = explicitId || extractPostId(postUrl) || extractPcbPostId(card);
  if (!postUrl && postId) {
    const group = parseGroupSource(baseUrl);
    if (group) postUrl = normalizeUrl(`${group.groupUrl}posts/${postId}/`);
  }
  const contentElement = first(card, DOM_RULES.content);
  const contentText = cleanText(contentElement?.textContent);

  const cardText = cleanText(card.textContent);
  const anonymous = containsAny(cardText, TEXT_SIGNALS.anonymous);
  const authorElement = first(card, DOM_RULES.author) as HTMLAnchorElement | null;
  const authorName = anonymous
    ? TEXT_SIGNALS.anonymous.find((label) => cardText.toLocaleLowerCase().includes(label.toLocaleLowerCase())) ?? null
    : cleanText(authorElement?.getAttribute("data-fbgpe-author") || authorElement?.getAttribute("aria-label") || authorElement?.textContent) || null;
  const authorUrl = anonymous ? null : normalizeUrl(authorElement?.getAttribute("href"), baseUrl);

  const timeElement = first(card, DOM_RULES.time);
  const permalinkTime = cleanText(permalink?.getAttribute("aria-label") || permalink?.textContent);
  const publishedTimeRaw = attributeOrText(timeElement, "data-fbgpe-time")
    ?? (looksLikeDisplayedTime(permalinkTime) ? permalinkTime : null);
  const machineTime = timeElement?.getAttribute("datetime") || timeElement?.getAttribute("data-utime");
  const publishedAt = /^\d+$/.test(machineTime ?? "")
    ? new Date(Number(machineTime) * 1000).toISOString()
    : normalizeAbsoluteTime(machineTime);

  if (!postId && !postUrl && (!contentText || (!authorName && !publishedTimeRaw))) return null;

  const truncatedAttr = card.getAttribute("data-fbgpe-truncated");
  const contentIsTruncated = truncatedAttr === "true" ? true : truncatedAttr === "false" ? false : findSeeMore(card) ? true : null;
  const reactionRaw = findMetric(card, "reaction");
  const commentRaw = findMetric(card, "comment");
  const shareRaw = findMetric(card, "share");
  const warnings: string[] = [];
  if (!postId && !postUrl) warnings.push("missing_post_identity");
  if (contentIsTruncated) warnings.push("content_truncated");
  if (publishedTimeRaw && !publishedAt) warnings.push("published_time_not_normalized");
  if (reactionRaw && normalizeCount(reactionRaw) === null) warnings.push("reaction_count_not_normalized");
  if (commentRaw && normalizeCount(commentRaw) === null) warnings.push("comment_count_not_normalized");
  if (shareRaw && normalizeCount(shareRaw) === null) warnings.push("share_count_not_normalized");

  return {
    post_id: postId,
    post_url: postUrl,
    author_name: authorName,
    author_url: authorUrl,
    is_anonymous: anonymous ? true : authorName ? false : null,
    content_text: contentText,
    content_is_truncated: contentIsTruncated,
    published_time_raw: publishedTimeRaw,
    published_at: publishedAt,
    reaction_count_raw: reactionRaw,
    reaction_count: normalizeCount(reactionRaw),
    comment_count_raw: commentRaw,
    comment_count: normalizeCount(commentRaw),
    share_count_raw: shareRaw,
    share_count: normalizeCount(shareRaw),
    media: parseMedia(card, baseUrl),
    is_pinned: containsAny(cardText, TEXT_SIGNALS.pinned) ? true : null,
    scraped_at: scrapedAt,
    warnings,
  };
}

function findPostPermalink(card: Element): HTMLAnchorElement | null {
  for (const selector of DOM_RULES.permalink) {
    for (const element of card.querySelectorAll<HTMLAnchorElement>(selector)) {
      const href = element.getAttribute("href");
      if (href && !isCommentPermalink(href)) return element;
    }
  }
  return null;
}

function isCommentPermalink(raw: string): boolean {
  try {
    const url = new URL(raw, "https://www.facebook.com/");
    return [...url.searchParams.keys()].some((key) => key === "comment_id" || key === "reply_comment_id");
  } catch {
    return true;
  }
}

function extractPcbPostId(card: Element): string | null {
  for (const anchor of card.querySelectorAll<HTMLAnchorElement>('a[href*="set=pcb."]')) {
    try {
      const set = new URL(anchor.getAttribute("href")!, "https://www.facebook.com/").searchParams.get("set");
      const match = set?.match(/^pcb\.(\d+)$/);
      if (match) return match[1];
    } catch {
      // Try the next rendered attachment URL.
    }
  }
  return null;
}

function looksLikeDisplayedTime(value: string): boolean {
  return Boolean(value) && (/\d/u.test(value) || /^(?:昨天|剛剛|Yesterday|Just now)$/iu.test(value));
}
