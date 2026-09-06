const TRACKING_PARAMS = new Set(["fbclid", "__cft__", "__tn__", "mibextid", "ref", "refid", "paipv"]);

export function normalizeUrl(raw: string | null | undefined, base = "https://www.facebook.com/"): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    if (isFacebookHost(url.hostname)) {
      if (url.hostname === "l.facebook.com" || url.hostname === "lm.facebook.com") {
        const target = url.searchParams.get("u");
        return target ? normalizeUrl(target, base) : null;
      }
      url.hostname = "www.facebook.com";
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(key) || key.startsWith("__cft__")) url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isFacebookHost(host: string): boolean {
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

export interface GroupSource { groupId: string | null; groupSlug: string | null; groupUrl: string }

export function parseGroupSource(raw: string): GroupSource | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "www.facebook.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "groups" || !parts[1]) return null;
    const key = parts[1];
    const groupId = /^\d+$/.test(key) ? key : null;
    return { groupId, groupSlug: groupId ? null : key, groupUrl: `https://www.facebook.com/groups/${key}/` };
  } catch {
    return null;
  }
}

export function extractPostId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/\/(?:posts|permalink)\/(\d+)/);
    return pathMatch?.[1] ?? parsed.searchParams.get("story_fbid") ?? null;
  } catch { return null; }
}
