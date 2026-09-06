const URL_PATTERN = /https?:\/\/[^\s<>"'「」，。；！？（）【】《》]+/giu;
const TRAILING_PUNCTUATION = /[),.;!?，。；！？）】》]+$/u;

function canonicalize(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com")) {
      for (const key of ["fbclid", "__tn__", "__cft__", "mibextid"]) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function classify(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLocaleLowerCase("en-US");
    if (hostname === "line.me" || hostname.endsWith(".line.me") || hostname === "lin.ee") return "line";
    if (hostname === "facebook.com" || hostname.endsWith(".facebook.com")) return "facebook";
    return "external";
  } catch {
    return "unknown";
  }
}

function link(rawUrl, source, kind = classify(rawUrl)) {
  if (!rawUrl) return null;
  return { raw_url: rawUrl, canonical_url: canonicalize(rawUrl), source, kind };
}

export function extractInlineUrls(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(URL_PATTERN)) {
    const rawUrl = match[0].replace(TRAILING_PUNCTUATION, "");
    if (rawUrl) found.push(rawUrl);
  }
  return [...new Set(found)];
}

export function maskInlineUrls(text, urls = extractInlineUrls(text)) {
  let masked = String(text ?? "");
  for (const url of [...urls].sort((a, b) => b.length - a.length)) masked = masked.split(url).join("〔網址已由程式保留〕");
  return masked;
}

export function buildLinkInventory(batch, post) {
  const inline = extractInlineUrls(post?.content_text).map((url) => link(url, "content_text"));
  const media = (post?.media ?? []).map((item) => item?.url ? { ...link(item.url, "media"), media_type: item.type ?? null } : null).filter(Boolean);
  const registration = inline.filter(({ kind }) => kind === "line" || kind === "external");
  return {
    group: link(post?.group_url ?? batch?.group_url ?? null, "group_url", "facebook"),
    post: link(post?.post_url ?? null, "post_url", "facebook"),
    author: link(post?.author_url ?? null, "author_url", "facebook"),
    media,
    inline,
    registration,
  };
}
