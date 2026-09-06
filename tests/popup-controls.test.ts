import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BATCH_SETTINGS, toPacingInfo } from "../src/core/settings";
import { emptyStats, type ActiveBatch, type Message, type SessionState } from "../src/shared/types";

describe("popup result controls", () => {
  let state: SessionState;
  const messages: Message[] = [];
  const tabMessages: Message[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    messages.length = 0;
    tabMessages.length = 0;
    document.documentElement.innerHTML = readFileSync(resolve("src/popup/index.html"), "utf8");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value() { this.setAttribute("open", ""); },
    });
    state = {
      active: null,
      resultHandled: false,
      lastError: null,
      result: {
        batch: {
          batch_id: "batch-1", source: "facebook_group", status: "stopped", stop_reason: "user_stopped",
          group_id: "123", group_name: "Group", group_url: "https://www.facebook.com/groups/123/",
          target_post_count: 5, no_new_scan_limit: 10, pacing: toPacingInfo(DEFAULT_BATCH_SETTINGS.pacing), max_duration_seconds: 1800,
          started_at: "2026-08-30T00:00:00.000Z", finished_at: "2026-08-30T00:01:00.000Z", stats: emptyStats(),
        },
        posts: [],
      },
    };
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async (message: Message) => {
          messages.push(message);
          if (message.type === "DISCARD_RESULT") state = { ...state, result: null, resultHandled: true };
          if (message.type === "PREPARE_START") {
            const active: ActiveBatch = {
              batchId: message.batchId, tabId: message.tabId, groupName: null, groupUrl: "https://www.facebook.com/groups/123/",
              phase: "preflight", settings: message.settings, startedAt: "2026-08-30T00:02:00.000Z",
              stats: emptyStats(), noNewCount: 0,
            };
            state = { ...state, active, result: null, resultHandled: true };
            return { ok: true };
          }
          if (message.type === "CANCEL_PREPARE") {
            if (state.active?.phase === "preflight" && state.active.batchId === message.batchId) state = { ...state, active: null };
            return { ok: true };
          }
          return message.type === "GET_STATE" ? { ok: true, data: state } : { ok: true };
        }),
      },
      storage: { local: { get: vi.fn(async () => ({ responsibilityAccepted: true })), set: vi.fn() } },
      tabs: {
        query: vi.fn(async () => [{ id: 7, url: "https://www.facebook.com/groups/123/" }]),
        sendMessage: vi.fn(async (_tabId: number, message: Message) => { tabMessages.push(message); return { ok: true }; }),
        update: vi.fn(),
      },
      scripting: { executeScript: vi.fn() },
      downloads: { download: vi.fn() },
    });
  });

  afterEach(() => vi.useRealTimers());

  it("discards a result through an in-popup confirmation", async () => {
    await import("../src/popup/index");
    await flushMicrotasks();

    document.querySelector<HTMLButtonElement>("#discard")!.click();
    const dialog = document.querySelector<HTMLDialogElement>("#discard-confirmation")!;
    expect(dialog.hasAttribute("open")).toBe(true);

    dialog.returnValue = "discard";
    dialog.dispatchEvent(new Event("close"));
    await flushMicrotasks();

    expect(messages.some((message) => message.type === "DISCARD_RESULT")).toBe(true);
    expect(document.querySelector("#result")!.classList).toContain("hidden");
    expect(document.querySelector("#controls")!.classList).not.toContain("hidden");
  });

  it("shows actionable card failure counts", async () => {
    state.result!.batch.stats = {
      scanned: 4,
      exported: 1,
      excluded: 0,
      duplicates: 0,
      failed: 3,
      failed_by_reason: { unknown_card: 1, minimum_data: 2, exception: 0 },
    };
    await import("../src/popup/index");
    await flushMicrotasks();

    expect(document.querySelector("#failure-details")!.textContent).toBe("失敗原因：未知卡片 1、最低資料不足 2、解析例外 0");
    expect(document.querySelector("#failure-details")!.classList).not.toContain("hidden");
  });

  it("starts a batch with the user's selected post target", async () => {
    state = { ...state, result: null, resultHandled: true };
    await import("../src/popup/index");
    await flushMicrotasks();

    document.querySelector<HTMLInputElement>("#target-count")!.value = "12";
    document.querySelector<HTMLInputElement>("#max-duration-minutes")!.value = "45";
    document.querySelector<HTMLInputElement>("#no-new-limit")!.value = "20";
    document.querySelector<HTMLInputElement>("#card-delay-min")!.value = "500";
    document.querySelector<HTMLInputElement>("#card-delay-max")!.value = "800";
    document.querySelector<HTMLButtonElement>("#start")!.click();
    await flushMicrotasks();

    const prepared = messages.find((message) => message.type === "PREPARE_START");
    expect(prepared).toEqual(expect.objectContaining({
      type: "PREPARE_START", batchId: expect.any(String),
      settings: expect.objectContaining({ targetPostCount: 12, maxDurationMinutes: 45, noNewScanLimit: 20, pacing: expect.objectContaining({ cardDelayMinMs: 500 }) }),
    }));
    expect(tabMessages).toContainEqual(expect.objectContaining({
      type: "START_BATCH", batchId: prepared && "batchId" in prepared ? prepared.batchId : "",
      settings: expect.objectContaining({ targetPostCount: 12, maxDurationMinutes: 45, noNewScanLimit: 20 }),
    }));
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      batchSettings: expect.objectContaining({ targetPostCount: 12, maxDurationMinutes: 45, noNewScanLimit: 20 }),
    });
  });

  it("rejects invalid advanced settings before preparing a batch", async () => {
    state = { ...state, result: null, resultHandled: true };
    await import("../src/popup/index");
    await flushMicrotasks();

    document.querySelector<HTMLInputElement>("#card-delay-min")!.value = "900";
    document.querySelector<HTMLInputElement>("#card-delay-max")!.value = "500";
    document.querySelector<HTMLButtonElement>("#start")!.click();
    await flushMicrotasks();

    expect(messages.some((message) => message.type === "PREPARE_START")).toBe(false);
    expect(document.querySelector("#notice")!.textContent).toContain("批次設定無效");
  });

  it("restores and persists all default settings", async () => {
    await import("../src/popup/index");
    await flushMicrotasks();
    document.querySelector<HTMLInputElement>("#no-new-limit")!.value = "30";
    document.querySelector<HTMLInputElement>("#scroll-percent-min")!.value = "20";

    document.querySelector<HTMLButtonElement>("#reset-settings")!.click();
    await flushMicrotasks();

    expect(document.querySelector<HTMLInputElement>("#no-new-limit")!.value).toBe("10");
    expect(document.querySelector<HTMLInputElement>("#max-duration-minutes")!.value).toBe("30");
    expect(document.querySelector<HTMLInputElement>("#scroll-percent-min")!.value).toBe("70");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ batchSettings: DEFAULT_BATCH_SETTINGS });
  });

  it("loads the last saved batch settings", async () => {
    const saved = {
      ...structuredClone(DEFAULT_BATCH_SETTINGS),
      noNewScanLimit: 24,
      maxDurationMinutes: 90,
      pacing: { ...DEFAULT_BATCH_SETTINGS.pacing, scrollDelayMinMs: 4_500, scrollDelayMaxMs: 5_000 },
    };
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => (
      key === "batchSettings" ? { batchSettings: saved } : { responsibilityAccepted: true }
    ));

    await import("../src/popup/index");
    await flushMicrotasks();

    expect(document.querySelector<HTMLInputElement>("#no-new-limit")!.value).toBe("24");
    expect(document.querySelector<HTMLInputElement>("#max-duration-minutes")!.value).toBe("90");
    expect(document.querySelector<HTMLInputElement>("#scroll-delay-min")!.value).toBe("4500");
  });

  it("migrates the previous untouched pacing defaults", async () => {
    const stored = {
      ...structuredClone(DEFAULT_BATCH_SETTINGS),
      targetPostCount: 200,
      pacing: {
        cardDelayMinMs: 350,
        cardDelayMaxMs: 700,
        scrollDelayMinMs: 2_200,
        scrollDelayMaxMs: 3_600,
        noNewBackoffStepMs: 800,
        noNewBackoffMaxMs: 4_000,
        scrollDistanceMinPercent: 45,
        scrollDistanceMaxPercent: 75,
      },
    };
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => (
      key === "batchSettings" ? { batchSettings: stored } : { responsibilityAccepted: true }
    ));

    await import("../src/popup/index");
    await flushMicrotasks();

    expect(document.querySelector<HTMLInputElement>("#target-count")!.value).toBe("200");
    expect(document.querySelector<HTMLInputElement>("#card-delay-min")!.value).toBe("100");
    expect(document.querySelector<HTMLInputElement>("#scroll-delay-max")!.value).toBe("900");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      batchSettings: expect.objectContaining({
        targetPostCount: 200,
        pacing: expect.objectContaining({ cardDelayMinMs: 100, scrollDistanceMaxPercent: 95 }),
      }),
    });
  });

  it("cancels a prepared batch without requiring a content runner", async () => {
    state = {
      ...state,
      active: {
        batchId: "prepared-batch", tabId: 7, groupName: null, groupUrl: "https://www.facebook.com/groups/123/",
        phase: "preflight", settings: structuredClone(DEFAULT_BATCH_SETTINGS), startedAt: "2026-08-30T00:02:00.000Z", stats: emptyStats(), noNewCount: 0,
      },
      result: null,
    };
    await import("../src/popup/index");
    await flushMicrotasks();

    document.querySelector<HTMLButtonElement>("#stop")!.click();
    await flushMicrotasks();

    expect(messages.some((message) => message.type === "CANCEL_PREPARE")).toBe(true);
    expect(tabMessages.some((message) => message.type === "STOP_BATCH")).toBe(false);
    expect(state.active).toBeNull();
    expect(document.querySelector("#controls")!.classList).not.toContain("hidden");
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
