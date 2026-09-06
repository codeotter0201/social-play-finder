// @vitest-environment-options { "url": "https://www.facebook.com/groups/123/" }

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchRunner } from "../src/content/runner";
import { DEFAULT_BATCH_SETTINGS } from "../src/core/settings";
import type { Message } from "../src/shared/types";

describe("batch runner lifecycle", () => {
  const messages: Message[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    messages.length = 0;
    document.body.innerHTML = `
      <main role="feed">
        <article role="article">
          <a data-fbgpe-author href="https://www.facebook.com/user/1">Author</a>
          <time datetime="2026-08-30T00:00:00.000Z">1 hr</time>
          <a href="https://www.facebook.com/groups/123/posts/1/">permalink</a>
          <div data-fbgpe-content>Post</div>
        </article>
      </main>`;
    window.history.replaceState({}, "", "/groups/123/");
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(window, "scrollBy", { configurable: true, value: vi.fn() });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async (message: Message) => {
          messages.push(structuredClone(message));
          return { ok: true };
        }),
      },
    });
  });

  it("finishes a stopped run immediately and allows a fresh run after manual scrolling", async () => {
    const first = new BatchRunner();
    const firstStart = first.start("batch-1", settings());
    await flushMicrotasks();
    expect(messages.some((message) => message.type === "RUNNER_STARTED")).toBe(true);

    first.stop();
    await Promise.resolve();

    expect(messages.some((message) => message.type === "RUNNER_FINISHED" && message.result.batch.stop_reason === "user_stopped")).toBe(true);

    window.scrollBy({ top: 500 });
    const second = new BatchRunner();
    const secondStart = second.start("batch-2", settings({ targetPostCount: 12 }));
    await flushMicrotasks();
    expect(messages.filter((message) => message.type === "RUNNER_STARTED")).toHaveLength(2);
    second.stop();
    await Promise.resolve();

    expect(messages.filter((message) => message.type === "RUNNER_FINISHED")).toHaveLength(2);
    await Promise.all([firstStart, secondStart]);
  });

  it("finishes at the selected post target", async () => {
    const runner = new BatchRunner();
    await runner.start("selected-target", settings({ targetPostCount: 1 }));

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "selected-target", target_post_count: 1, stop_reason: "target_reached" } },
    });
  });

  it("scrolls a hidden source tab and waits for delayed feed content", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    let scrollY = 0;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn((options: ScrollToOptions) => {
        if (options.behavior !== "auto") return;
        scrollY += Number(options.top ?? 0);
        window.setTimeout(() => {
          document.querySelector("[role='feed']")!.insertAdjacentHTML("beforeend", `
            <article role="article">
              <a data-fbgpe-author href="https://www.facebook.com/user/2">Second author</a>
              <a href="https://www.facebook.com/groups/123/posts/2/">permalink</a>
              <div data-fbgpe-content>Second post</div>
            </article>`);
        }, 1_200);
      }),
    });
    const runner = new BatchRunner();
    const started = runner.start("hidden-source", settings({ targetPostCount: 2, noNewScanLimit: 1 }));
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "hidden-source", status: "completed", stop_reason: "target_reached" } },
    });
    expect(window.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("does not spend the no-new budget while scrolling through existing content", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    let scrollY = 0;
    let scrollCalls = 0;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => 10_000 });
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn((options: ScrollToOptions) => {
        scrollCalls += 1;
        scrollY += Number(options.top ?? 0);
        if (scrollCalls !== 3) return;
        window.setTimeout(() => {
          document.querySelector("[role='feed']")!.insertAdjacentHTML("beforeend", `
            <article role="article">
              <a data-fbgpe-author href="https://www.facebook.com/user/2">Second author</a>
              <a href="https://www.facebook.com/groups/123/posts/2/">permalink</a>
              <div data-fbgpe-content>Second post</div>
            </article>`);
        }, 1_200);
      }),
    });
    const runner = new BatchRunner();
    const started = runner.start("long-existing-feed", settings({ targetPostCount: 2, noNewScanLimit: 2 }));
    await vi.advanceTimersByTimeAsync(20_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "long-existing-feed", status: "completed", stop_reason: "target_reached" } },
    });
    expect(scrollCalls).toBeGreaterThanOrEqual(3);
  });

  it("waits instead of completing when a hidden tab cannot make scroll progress", async () => {
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 10_000 });
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn(() => {
        if (hidden || document.querySelector("[href*='/posts/2/']")) return;
        document.querySelector("[role='feed']")!.insertAdjacentHTML("beforeend", `
          <article role="article">
            <a data-fbgpe-author href="https://www.facebook.com/user/2">Second author</a>
            <a href="https://www.facebook.com/groups/123/posts/2/">permalink</a>
            <div data-fbgpe-content>Second post</div>
          </article>`);
      }),
    });
    const runner = new BatchRunner();
    const started = runner.start("hidden-no-progress", settings({ targetPostCount: 2, noNewScanLimit: 1 }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(messages.some((message) => message.type === "RUNNER_FINISHED")).toBe(false);
    expect(messages.some((message) => message.type === "RUNNER_PROGRESS" && message.active.phase === "waiting_for_foreground")).toBe(true);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "hidden-no-progress", status: "completed", stop_reason: "target_reached" } },
    });
  });

  it("reports card failures by reason", async () => {
    document.body.innerHTML = `
      <main role="feed">
        <div data-fbgpe-card data-fbgpe-kind="unknown"></div>
        <div data-fbgpe-card data-fbgpe-kind="supported"></div>
      </main>`;
    const runner = new BatchRunner();
    const started = runner.start("failure-reasons", settings({ targetPostCount: 5, noNewScanLimit: 1 }));
    await vi.advanceTimersByTimeAsync(20_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: {
        batch: {
          stats: {
            failed: 2,
            failed_by_reason: { unknown_card: 1, minimum_data: 1, exception: 0 },
          },
        },
      },
    });
  });

  it("uses the selected no-new scan limit", async () => {
    const runner = new BatchRunner();
    const started = runner.start("no-new-limit", settings({ targetPostCount: 5, noNewScanLimit: 2 }));
    await vi.advanceTimersByTimeAsync(20_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "no-new-limit", no_new_scan_limit: 2, stop_reason: "no_new_posts" } },
    });
  });

  it("does not treat unrelated DOM mutations as feed progress", async () => {
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn(() => document.body.insertAdjacentHTML("beforeend", "<span data-ui-noise></span>")),
    });
    const runner = new BatchRunner();
    const started = runner.start("mutation-noise", settings({ targetPostCount: 2, noNewScanLimit: 1, maxDurationMinutes: 1 }));
    await vi.advanceTimersByTimeAsync(70_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "mutation-noise", stop_reason: "no_new_posts" } },
    });
  });

  it("uses the selected auto-scroll time limit", async () => {
    const runner = new BatchRunner();
    const started = runner.start("time-limit", settings({ targetPostCount: 5, noNewScanLimit: 100, maxDurationMinutes: 1 }));
    await flushMicrotasks();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    const finished = messages.find((message) => message.type === "RUNNER_FINISHED");
    expect(finished).toMatchObject({
      type: "RUNNER_FINISHED",
      result: { batch: { batch_id: "time-limit", max_duration_seconds: 60, stop_reason: "time_limit_reached" } },
    });
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function settings(overrides: Partial<{ targetPostCount: number; maxDurationMinutes: number; noNewScanLimit: number }> = {}) {
  return {
    ...structuredClone(DEFAULT_BATCH_SETTINGS),
    ...overrides,
  };
}
