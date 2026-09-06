import { PostCollector } from "../core/collector";
import { cardPacingDelay, scanPacingDelay, scrollDistance } from "../core/pacing";
import { parseBatchSettings, toPacingInfo } from "../core/settings";
import { classifyCard, findCards, findSeeMore, isProgressCard, parseCard } from "../core/parser";
import { preflight, type PreflightSuccess } from "../core/preflight";
import { DOM_RULES, TEXT_SIGNALS, UNSUPPORTED_GROUP_SEGMENTS } from "../shared/rules";
import {
  type ActiveBatch, type BatchEnvelope,
  type BatchSettings, type BatchStatus, type Message, type StopReason,
} from "../shared/types";
import { parseGroupSource } from "../shared/url";

export class BatchRunner {
  private readonly collector = new PostCollector();
  private readonly observed = new WeakSet<Element>();
  private stopped = false;
  private ended = false;
  private running = false;
  private wakeDelay: (() => void) | null = null;
  private navigationTimer: number | null = null;
  private active!: ActiveBatch;
  private source!: PreflightSuccess;

  async start(batchId: string, requestedSettings: BatchSettings): Promise<void> {
    const settings = parseBatchSettings(requestedSettings);
    if (!batchId || !settings) return;
    const checked = preflight(document, location.href);
    if (!checked.ok) {
      await send({ type: "RUNNER_PREFLIGHT_FAILED", code: checked.code });
      return;
    }
    this.source = checked;
    this.active = {
      batchId, tabId: -1, groupName: checked.groupName, groupUrl: checked.groupUrl,
      phase: "scanning", settings, startedAt: new Date().toISOString(),
      stats: this.collector.stats, noNewCount: 0,
    };
    const response = await send({ type: "RUNNER_STARTED", active: this.active });
    if (!response?.ok) return;
    this.running = true;
    this.navigationTimer = window.setInterval(() => {
      if (this.sourceChanged()) void this.finish("stopped", "page_navigated");
    }, 250);

    try {
      await this.runAutoScroll();
    } catch {
      await this.finish("failed", "fatal_error");
    }
  }

  stop(): void {
    this.stopped = true;
    this.wakeDelay?.();
    if (this.running && !this.ended) void this.finish("stopped", "user_stopped");
  }

  navigateAway(): void {
    if (this.running && !this.ended) void this.finish("stopped", "page_navigated");
  }

  private async runAutoScroll(): Promise<void> {
    const maxDurationMs = this.active.settings.maxDurationMinutes * 60_000;
    while (!this.stopped) {
      if (this.sourceChanged()) return this.finish("stopped", "page_navigated");
      if (Date.now() - new Date(this.active.startedAt).valueOf() >= maxDurationMs) return this.finish("stopped", "time_limit_reached");
      if (isFacebookBlocked()) return this.finish("failed", "facebook_blocked");
      if (hasPageSignal(TEXT_SIGNALS.accessDenied)) return this.finish("failed", "access_denied");
      if (!DOM_RULES.feed.some((selector) => document.querySelector(selector))) return this.finish("failed", "dom_changed");
      this.active.phase = "scanning";
      const before = this.collector.stats.scanned;
      let progressed = false;
      for (const card of findCards(document)) {
        if (this.observed.has(card)) continue;
        const result = await this.process(card);
        if (result === "exported" || result === "excluded" || result === "failed") progressed ||= isProgressCard(classifyCard(card));
        if (this.reachedTarget()) return this.finish("completed", "target_reached");
        if (this.stopped) return this.finish("stopped", "user_stopped");
        await this.delay(cardPacingDelay(this.active.settings.pacing));
        if (this.stopped) return this.finish("stopped", "user_stopped");
      }
      const foundNewCard = this.collector.stats.scanned !== before && progressed;
      this.active.phase = "scrolling";
      const scroll = await this.scrollAndWaitForFeed(scanPacingDelay(this.active.noNewCount, this.active.settings.pacing));
      if (this.stopped) return this.finish("stopped", "user_stopped");
      if (foundNewCard || scroll.newCardAvailable || scroll.moved || scroll.heightGrew) {
        this.active.noNewCount = 0;
        this.active.phase = "scrolling";
      } else if (scroll.startedHidden || document.hidden) {
        this.active.phase = "waiting_for_foreground";
      } else {
        this.active.noNewCount += 1;
      }
      await this.publish();
      if (this.active.noNewCount >= this.active.settings.noNewScanLimit) return this.finish("completed", "no_new_posts");
    }
    await this.finish("stopped", "user_stopped");
  }

  private async process(card: Element): Promise<"exported" | "duplicate" | "excluded" | "ignored" | "failed"> {
    this.observed.add(card);
    try {
      const kind = classifyCard(card);
      if (kind === "ignored") { this.collector.recordExcluded(); return "ignored"; }
      if (kind === "excluded") { this.collector.recordExcluded(); return "excluded"; }
      if (kind === "unknown") { this.collector.recordFailed("unknown_card"); return "failed"; }
      await expandContent(card);
      const post = parseCard(card, location.href);
      if (!post) { this.collector.recordFailed("minimum_data"); return "failed"; }
      return this.collector.record(post);
    } catch {
      this.collector.recordFailed("exception");
      return "failed";
    }
  }

  private reachedTarget(): boolean {
    return this.collector.posts.length >= this.active.settings.targetPostCount;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (this.wakeDelay === finish) this.wakeDelay = null;
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      this.wakeDelay = finish;
      if (this.stopped) finish();
    });
  }

  private scrollAndWaitForFeed(minimumDelayMs: number): Promise<ScrollOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let minimumElapsed = false;
      let feedMutated = false;
      let minimumTimer: number | null = null;
      let maximumTimer: number | null = null;
      const before = scrollSnapshot();
      const startedHidden = document.hidden;
      const maximumDelayMs = document.hidden ? Math.max(minimumDelayMs, 3_000) : minimumDelayMs;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        document.removeEventListener("visibilitychange", visibilityChanged);
        if (minimumTimer !== null) window.clearTimeout(minimumTimer);
        if (maximumTimer !== null) window.clearTimeout(maximumTimer);
        if (this.wakeDelay === finish) this.wakeDelay = null;
        const after = scrollSnapshot();
        resolve({
          moved: after.top > before.top + 1,
          heightGrew: after.height > before.height + 1,
          newCardAvailable: findCards(document).some((card) => !this.observed.has(card) && isProgressCard(classifyCard(card))),
          startedHidden,
        });
      };
      const observer = new MutationObserver(() => {
        feedMutated = true;
        if (minimumElapsed) finish();
      });
      const visibilityChanged = () => {
        if (!document.hidden) finish();
      };
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("visibilitychange", visibilityChanged);
      minimumTimer = window.setTimeout(() => {
        minimumElapsed = true;
        const current = scrollSnapshot();
        if (feedMutated || !document.hidden || current.top > before.top + 1 || current.height > before.height + 1) finish();
      }, minimumDelayMs);
      maximumTimer = window.setTimeout(finish, maximumDelayMs);
      this.wakeDelay = finish;
      window.scrollBy({
        top: scrollDistance(window.innerHeight, this.active.settings.pacing),
        behavior: "auto",
      });
      if (this.stopped) finish();
    });
  }

  private sourceChanged(): boolean {
    if (parseGroupSource(location.href)?.groupUrl !== this.source.groupUrl) return true;
    try {
      const trailingSegments = new URL(location.href).pathname.split("/").filter(Boolean).slice(2);
      return trailingSegments.some((segment) => UNSUPPORTED_GROUP_SEGMENTS.has(segment));
    } catch {
      return true;
    }
  }

  private envelope(status: BatchStatus, stopReason: StopReason, finishedAt = new Date().toISOString()): BatchEnvelope {
    return {
      batch: {
        batch_id: this.active.batchId, source: "facebook_group", status, stop_reason: stopReason,
        group_id: this.source.groupId, group_name: this.source.groupName, group_url: this.source.groupUrl,
        target_post_count: this.active.settings.targetPostCount,
        no_new_scan_limit: this.active.settings.noNewScanLimit,
        pacing: toPacingInfo(this.active.settings.pacing),
        max_duration_seconds: this.active.settings.maxDurationMinutes * 60,
        started_at: this.active.startedAt, finished_at: finishedAt, stats: snapshotStats(this.collector.stats),
      },
      posts: [...this.collector.posts],
    };
  }

  private async publish(): Promise<void> {
    this.active.stats = snapshotStats(this.collector.stats);
    await send({ type: "RUNNER_PROGRESS", active: this.active, partial: this.envelope("stopped", "page_navigated") });
  }

  private async finish(status: BatchStatus, reason: StopReason): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    if (this.navigationTimer !== null) window.clearInterval(this.navigationTimer);
    await send({ type: "RUNNER_FINISHED", result: this.envelope(status, reason) });
  }
}

interface ScrollOutcome {
  moved: boolean;
  heightGrew: boolean;
  newCardAvailable: boolean;
  startedHidden: boolean;
}

function scrollSnapshot(): { top: number; height: number } {
  const root = document.scrollingElement ?? document.documentElement;
  return {
    top: Math.max(window.scrollY || 0, root.scrollTop || 0, document.body.scrollTop || 0),
    height: Math.max(root.scrollHeight || 0, document.body.scrollHeight || 0),
  };
}

export async function expandContent(card: Element): Promise<void> {
  const button = findSeeMore(card);
  if (!button) return;
  const before = findContent(card)?.textContent ?? "";
  button.click();
  await waitForContentChange(card, before, 1_500);
  const stillTruncated = Boolean(findSeeMore(card));
  const contentChanged = (findContent(card)?.textContent ?? "") !== before;
  card.setAttribute("data-fbgpe-truncated", !stillTruncated && contentChanged ? "false" : "true");
}

function findContent(card: Element): Element | null {
  return DOM_RULES.content.map((selector) => card.querySelector(selector)).find(Boolean) ?? null;
}

function waitForContentChange(card: Element, before: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if ((findContent(card)?.textContent ?? "") !== before) finish();
    });
    const timer = window.setTimeout(finish, timeoutMs);
    observer.observe(card, { childList: true, characterData: true, subtree: true });
    if ((findContent(card)?.textContent ?? "") !== before) finish();
  });
}

function isFacebookBlocked(): boolean {
  return hasPageSignal(TEXT_SIGNALS.blocked);
}

function hasPageSignal(signals: readonly string[]): boolean {
  const text = (document.body?.innerText || "").toLocaleLowerCase();
  return signals.some((signal) => text.includes(signal.toLocaleLowerCase()));
}

function snapshotStats(stats: ActiveBatch["stats"]): ActiveBatch["stats"] {
  return { ...stats, failed_by_reason: { ...stats.failed_by_reason } };
}

function send(message: Message): Promise<{ ok: boolean } | undefined> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}
