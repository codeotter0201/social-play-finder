// Only interpret a link already associated with the post author. No name lookup
// or network request: a group member ID can provide a direct profile URL.
const RESERVED_PATHS = new Set([
  "groups", "profile.php", "login", "logout", "login.php", "home.php", "index.php",
  "watch", "reel", "reels", "marketplace", "notifications", "friends", "share", "me",
  "help", "settings", "privacy", "policies", "terms", "pages", "people", "events",
  "photo", "photos", "video", "videos", "stories", "story.php", "permalink.php",
  "search", "gaming", "messages", "recover", "checkpoint", "dialog", "sharer", "sharer.php",
]);

export function facebookProfileUrl(raw, anonymous = false) {
  if (anonymous || typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw, "https://www.facebook.com/");
    if (!["https:", "http:"].includes(url.protocol) || !/^(www\.|m\.)?facebook\.com$/i.test(url.hostname) || url.username || url.password || url.port) return null;
    let id;
    if (url.pathname === "/profile.php") {
      if (url.searchParams.getAll("id").length !== 1) return null;
      id = url.searchParams.get("id");
    } else {
      id = url.pathname.match(/^\/groups\/[^/]+\/user\/([1-9]\d*)\/?$/)?.[1]
        ?? url.pathname.match(/^\/people\/[^/]+\/([1-9]\d*)\/?$/)?.[1]
        ?? url.pathname.match(/^\/([1-9]\d*)\/?$/)?.[1];
    }
    if (id !== undefined) return /^[1-9]\d*$/.test(id ?? "") ? `https://www.facebook.com/profile.php?id=${id}` : null;
    const username = url.pathname.match(/^\/([a-z0-9]+(?:\.[a-z0-9]+)*)\/?$/i)?.[1];
    if (!username || !/[a-z]/i.test(username) || /\.php$/i.test(username) || RESERVED_PATHS.has(username.toLowerCase())) return null;
    return `https://www.facebook.com/${username}`;
  } catch { return null; }
}
