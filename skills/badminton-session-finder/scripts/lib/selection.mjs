import { PLAY_FORMATS } from "./listing-types.mjs";
import { durationLabel, hourlyPriceLabel } from "./session-values.mjs";
export const MAX_SELECTED = 50;
export const MAX_COPY_CHARACTERS = 100_000;

export function authorIdentity(listing, anonymous = false) {
  if (anonymous || /匿名|anonymous/i.test(listing.source.author_name ?? "")) return null;
  try {
    const url = new URL(listing.source.author_url);
    if (url.protocol !== "https:" || !/^(www\.|m\.)?facebook\.com$/.test(url.hostname)) return null;
    const id = url.pathname === "/profile.php" ? url.searchParams.get("id") : url.pathname.match(/\/(?:user|people\/[^/]+)\/(\d+)\/?$/)?.[1];
    if (id && /^\d+$/.test(id)) return `facebook:id:${id}`;
    const name = url.pathname.match(/^\/([a-z\d.]+)\/?$/i)?.[1];
    if (name && !/^(groups|profile.php|login|home.php|watch|reel|marketplace|notifications|friends|share|me)$/i.test(name)) return `facebook:profile:${name.toLowerCase()}`;
  } catch { /* No reliable author identifier. */ }
  return null;
}

export function listingDate(listing) {
  return listing.schedule.date || (listing.schedule.recurrence ? `每週${listing.schedule.recurrence.weekdays.map(day => "日一二三四五六"[day]).join("、")}（日期需確認）` : "日期未定");
}
export function listingTime(listing) {
  const s = listing.schedule;
  return `${s.start_time || "未標示"}–${s.end_day_offset === 1 ? "次日 " : ""}${s.end_time || "未標示"}`;
}

export function buildSelectionCopy(listings) {
  if (listings.length > MAX_SELECTED) throw new Error(`最多選取 ${MAX_SELECTED} 場`);
  const sources = new Map();
  const cell = value => String(value ?? "未標示").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const lines = ["# 已選場次比較", "", "| 日期 | 時間 | 場館 | 時數 | 費用條件 | 每小時費用 | 玩法 | 程度 | 報名方式 | 來源 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const listing of listings) {
    const key = listing.source.post_key || listing.source_post_id;
    if (!sources.has(key)) sources.set(key, { number: sources.size + 1, listing });
    const contact = [listing.registration.instructions, listing.registration.line_id && `LINE：${listing.registration.line_id}`, listing.registration.phone].filter(Boolean).join("；");
    lines.push(`| ${[listingDate(listing), listingTime(listing), [listing.venue.name, listing.venue.address].filter(Boolean).join(" · "), durationLabel(listing.schedule), listing.price_display, hourlyPriceLabel(listing), PLAY_FORMATS[listing.play_format] || "", listing.skill.description, contact, sources.get(key).number].map(cell).join(" | ")} |`);
  }
  for (const { number, listing } of sources.values()) {
    lines.push("", `## 來源 ${number}`, `作者：${listing.source.author_name || "未標示"}`, `貼文網址：${listing.source.post_url || "未提供"}`, `作者網址：${listing.source.author_url || "未提供"}`, ...(listing.source.content_is_truncated ? ["來源標示：擷取的原文不完整"] : []), "", "原文：", listing.raw_text || "（未提供原文）");
  }
  const text = lines.join("\n");
  let characters = 0; for (const character of text) characters++;
  return { text, characters, sourceCount: sources.size, withinLimit: characters <= MAX_COPY_CHARACTERS };
}
