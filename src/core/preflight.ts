import { findCards } from "./parser";
import { DOM_RULES, TEXT_SIGNALS, UNSUPPORTED_GROUP_SEGMENTS } from "../shared/rules";
import type { PreflightCode } from "../shared/types";
import { parseGroupSource, type GroupSource } from "../shared/url";

export interface PreflightSuccess extends GroupSource { ok: true; groupName: string | null; cards: Element[] }
export interface PreflightFailure { ok: false; code: PreflightCode }
export type PreflightResult = PreflightSuccess | PreflightFailure;

export function preflight(document: Document, rawUrl: string): PreflightResult {
  const source = parseGroupSource(rawUrl);
  if (!source) return { ok: false, code: "unsupported_page" };
  const parts = new URL(rawUrl).pathname.split("/").filter(Boolean).slice(2);
  if (parts.some((part) => UNSUPPORTED_GROUP_SEGMENTS.has(part))) return { ok: false, code: "unsupported_page" };
  const bodyText = document.body?.innerText || document.body?.textContent || "";
  if (hasAny(bodyText, TEXT_SIGNALS.login) && document.querySelector('input[type="password"], form[action*="login"]')) return { ok: false, code: "not_logged_in" };
  if (hasAny(bodyText, TEXT_SIGNALS.accessDenied)) return { ok: false, code: "access_denied" };
  const hasFeed = DOM_RULES.feed.some((selector) => document.querySelector(selector));
  if (!hasFeed) return { ok: false, code: "dom_changed" };
  const name = findGroupName(document, source.groupUrl);
  return { ok: true, ...source, groupName: name, cards: findCards(document) };
}

function hasAny(value: string, signals: readonly string[]): boolean {
  const lower = value.toLocaleLowerCase();
  return signals.some((signal) => lower.includes(signal.toLocaleLowerCase()));
}

function findGroupName(document: Document, groupUrl: string): string | null {
  const clean = (value: string | null | undefined): string | null => {
    const text = value?.replace(/^\(\d+\)\s*/, "").replace(/\s*[|｜–-]\s*Facebook\s*$/i, "").trim();
    return text && !/^(通知|聊天室|聊天|動態消息|首頁|Facebook|Notifications|Chats|Messenger|Home)$/i.test(text) ? text : null;
  };
  const headings = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')]
    .filter(node => !node.closest('[role="dialog"], [role="navigation"], [role="banner"], [role="feed"], [role="article"]'));
  for (const heading of headings) for (const link of heading.querySelectorAll('a[href]')) {
    const href = link.getAttribute("href");
    try {
      const url = new URL(href!, groupUrl);
      if (parseGroupSource(url.href)?.groupUrl === groupUrl && url.pathname.replace(/\/$/, "") === new URL(groupUrl).pathname.replace(/\/$/, "")) {
        const name = clean(link.textContent); if (name) return name;
      }
    } catch { /* Ignore malformed links. */ }
  }
  const metadata = clean(document.querySelector('meta[property="og:title"]')?.getAttribute("content"));
  if (metadata) return metadata;
  const title = clean(document.title);
  if (title) return title;
  const names = [...new Set(headings.map(node => clean(node.textContent)).filter((name): name is string => Boolean(name)))];
  return names.length === 1 ? names[0] : null;
}
