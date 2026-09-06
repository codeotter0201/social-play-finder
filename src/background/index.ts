import { emptyStats, type ActiveBatch, type AppResponse, type BatchEnvelope, type Message, type SessionState, type Stats, type StopReason } from "../shared/types";
import { batchSettingsEqual, parseBatchSettings, toPacingInfo } from "../core/settings";
import { parseGroupSource } from "../shared/url";

const STATE_KEY = "sessionState";
const initialState: SessionState = { active: null, result: null, resultHandled: true, lastError: null };
let stateQueue: Promise<void> = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => { void chrome.storage.session.set({ [STATE_KEY]: initialState }); });

chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  void enqueue(() => handleMessage(message, sender)).then(respond).catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(() => stopForSourceLifecycle(tabId, "source_tab_closed"));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void enqueue(() => stopForSourceLifecycle(tabId, "page_navigated"));
});

async function handleMessage(message: Message, sender: chrome.runtime.MessageSender): Promise<AppResponse> {
  if (message.type === "GET_STATE") return { ok: true, data: await getState() };
  if (message.type === "PREPARE_START") {
    const state = await getState();
    if (state.active) return { ok: false, code: "batch_active", data: state.active };
    if (state.result && !state.resultHandled && !message.replaceResult) return { ok: false, code: "result_requires_action" };
    const settings = parseBatchSettings(message.settings);
    if (!settings) return { ok: false, code: "invalid_batch_settings" };
    const source = parseGroupSource(message.tabUrl);
    if (!source) return { ok: false, code: "unsupported_page" };
    state.result = null;
    state.resultHandled = true;
    state.lastError = null;
    state.active = {
      batchId: message.batchId, tabId: message.tabId, groupName: null, groupUrl: source.groupUrl,
      phase: "preflight", settings, startedAt: new Date().toISOString(), stats: emptyStats(), noNewCount: 0,
    };
    await saveState(state);
    await setBadge("…");
    return { ok: true };
  }
  if (message.type === "RUNNER_STARTED") {
    const state = await getState();
    if (!state.active || state.active.tabId !== sender.tab?.id || state.active.batchId !== message.active.batchId || !batchSettingsEqual(state.active.settings, message.active.settings)) return { ok: false, code: "not_prepared" };
    state.active = { ...message.active, tabId: sender.tab.id! };
    await saveState(state);
    await setBadge("ON");
    return { ok: true };
  }
  if (message.type === "RUNNER_PROGRESS") {
    const state = await getState();
    if (!state.active || state.active.tabId !== sender.tab?.id || state.active.batchId !== message.active.batchId) return { ok: false, code: "not_active" };
    state.active = { ...message.active, tabId: sender.tab.id! };
    state.result = message.partial;
    state.resultHandled = false;
    await saveState(state);
    await setBadge(String(Math.min(message.active.stats.exported, 999)));
    return { ok: true };
  }
  if (message.type === "RUNNER_FINISHED") {
    const state = await getState();
    if (!state.active || state.active.tabId !== sender.tab?.id || state.active.batchId !== message.result.batch.batch_id) return { ok: false, code: "not_active" };
    state.active = null;
    state.result = message.result;
    state.resultHandled = false;
    state.lastError = null;
    await saveState(state);
    await setBadge(null);
    return { ok: true };
  }
  if (message.type === "RUNNER_PREFLIGHT_FAILED") {
    const state = await getState();
    if (!state.active || state.active.tabId !== sender.tab?.id) return { ok: false, code: "not_prepared" };
    state.active = null;
    state.lastError = message.code;
    await saveState(state);
    await setBadge("!");
    return { ok: true };
  }
  if (message.type === "CANCEL_PREPARE") {
    const state = await getState();
    if (state.active?.phase !== "preflight" || state.active.batchId !== message.batchId) return { ok: false, code: "not_prepared" };
    state.active = null;
    await saveState(state);
    await setBadge(null);
    return { ok: true };
  }
  if (message.type === "DISCARD_RESULT") {
    const state = await getState();
    if (state.active) return { ok: false, code: "batch_active" };
    state.result = null; state.resultHandled = true; state.lastError = null;
    await saveState(state);
    return { ok: true };
  }
  if (message.type === "MARK_RESULT_HANDLED") {
    const state = await getState(); state.resultHandled = true; await saveState(state); return { ok: true };
  }
  return { ok: false, code: "unsupported_message" };
}

async function getState(): Promise<SessionState> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const state = (stored[STATE_KEY] as SessionState | undefined) ?? structuredClone(initialState);
  if (state.active) state.active.stats = normalizeStats(state.active.stats);
  if (state.result) state.result.batch.stats = normalizeStats(state.result.batch.stats);
  return state;
}
async function saveState(state: SessionState): Promise<void> { await chrome.storage.session.set({ [STATE_KEY]: state }); }
async function setBadge(text: string | null): Promise<void> {
  await chrome.action.setBadgeText({ text: text ?? "" });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: text === "!" ? "#b42318" : "#1769aa" });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = stateQueue.then(task, task);
  stateQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function stopForSourceLifecycle(tabId: number, reason: Extract<StopReason, "page_navigated" | "source_tab_closed">): Promise<void> {
  const state = await getState();
  if (state.active?.tabId !== tabId) return;
  const finishedAt = new Date().toISOString();
  const result = state.result ?? emptyStoppedResult(state.active, reason, finishedAt);
  result.batch.status = "stopped";
  result.batch.stop_reason = reason;
  result.batch.finished_at = finishedAt;
  result.batch.stats = { ...state.active.stats };
  state.result = result;
  state.active = null;
  state.resultHandled = false;
  await saveState(state);
  await setBadge(null);
}

function emptyStoppedResult(active: ActiveBatch, reason: Extract<StopReason, "page_navigated" | "source_tab_closed">, finishedAt: string): BatchEnvelope {
  const source = parseGroupSource(active.groupUrl);
  return {
    batch: {
      batch_id: active.batchId,
      source: "facebook_group",
      status: "stopped",
      stop_reason: reason,
      group_id: source?.groupId ?? null,
      group_name: active.groupName,
      group_url: active.groupUrl,
      target_post_count: active.settings.targetPostCount,
      no_new_scan_limit: active.settings.noNewScanLimit,
      pacing: toPacingInfo(active.settings.pacing),
      max_duration_seconds: active.settings.maxDurationMinutes * 60,
      started_at: active.startedAt,
      finished_at: finishedAt,
      stats: { ...active.stats },
    },
    posts: [],
  };
}

function normalizeStats(value: Stats): Stats {
  const defaults = emptyStats();
  return {
    ...defaults,
    ...value,
    failed_by_reason: { ...defaults.failed_by_reason, ...(value?.failed_by_reason ?? {}) },
  };
}
