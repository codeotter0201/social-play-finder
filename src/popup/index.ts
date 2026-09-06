import { makeFilenameStem, serializeCsv, serializeJson } from "../core/export";
import { DEFAULT_BATCH_SETTINGS, batchSettingsEqual, parseBatchSettings, parseStoredBatchSettings } from "../core/settings";
import { renderPostPreview } from "./preview";
import type { AppResponse, BatchEnvelope, BatchSettings, Message, PreflightCode, SessionState, Stats } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const controls = $("controls");
const status = $("status");
const result = $("result");
const notice = $("notice");
const start = $<HTMLButtonElement>("start");
const stop = $<HTMLButtonElement>("stop");
const dialog = $<HTMLDialogElement>("responsibility");
const discardDialog = $<HTMLDialogElement>("discard-confirmation");
const restartDialog = $<HTMLDialogElement>("restart-confirmation");
let starting = false;
const SETTINGS_KEY = "batchSettings";
let currentState: SessionState | null = null;

const errorLabels: Record<PreflightCode, string> = {
  unsupported_page: "頁面不受支援。請開啟 www.facebook.com 的社團主要動態牆。",
  not_logged_in: "Facebook 頁面明確顯示尚未登入。",
  access_denied: "Facebook 頁面明確顯示你無權查看此內容。",
  dom_changed: "無法辨識頁面；Facebook 頁面結構可能已變更。",
};
const reasonLabels: Record<string, string> = {
  target_reached: "已達設定篇數", no_new_posts: "已達連續無新貼文輪數",
  user_stopped: "使用者已停止", time_limit_reached: "已達設定時限", page_navigated: "來源頁面已導航或重新載入",
  source_tab_closed: "來源分頁已關閉", access_denied: "批次中失去瀏覽權限", facebook_blocked: "Facebook 顯示阻擋或限制",
  dom_changed: "Facebook 頁面結構可能已變更", fatal_error: "發生不可恢復錯誤",
};

$("acknowledge").addEventListener("change", (event) => { $("accept").toggleAttribute("disabled", !(event.target as HTMLInputElement).checked); });
$("help").addEventListener("click", () => dialog.showModal());
start.addEventListener("click", () => void begin());
stop.addEventListener("click", () => void stopBatch());
$("go-source").addEventListener("click", () => void goToSource());
$("json").addEventListener("click", () => void download("json"));
$("csv").addEventListener("click", () => void download("csv"));
$("discard").addEventListener("click", () => discardDialog.showModal());
$("reset-settings").addEventListener("click", () => {
  const settings = defaultSettings();
  writeSettings(settings);
  void chrome.storage.local.set({ [SETTINGS_KEY]: settings });
});
discardDialog.addEventListener("close", () => {
  if (discardDialog.returnValue === "discard") void discard();
  discardDialog.returnValue = "";
});

writeSettings(defaultSettings());
void loadSettings();
void refresh();
const poller = window.setInterval(() => void refresh(), 750);
window.addEventListener("unload", () => clearInterval(poller));

async function begin(): Promise<void> {
  if (starting) return;
  starting = true;
  start.disabled = true;
  try { await prepareStart(); }
  finally { starting = false; start.disabled = false; }
}

async function prepareStart(): Promise<void> {
  hideNotice();
  const settings = readSettings();
  if (!settings) return showNotice("批次設定無效。請確認數值範圍，且最小值不大於最大值。");
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const confirmed = (await chrome.storage.local.get("responsibilityAccepted")).responsibilityAccepted === true;
  if (!confirmed) {
    dialog.showModal();
    const accepted = await new Promise<boolean>((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), { once: true }));
    if (!accepted) return;
    await chrome.storage.local.set({ responsibilityAccepted: true });
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.id || !tab.url) return showNotice("無法取得目前分頁。");
  const batchId = crypto.randomUUID();
  let response = await send({ type: "PREPARE_START", batchId, tabId: tab.id, tabUrl: tab.url, settings, replaceResult: false });
  if (!response.ok && response.code === "result_requires_action") {
    restartDialog.returnValue = "";
    restartDialog.showModal();
    const replace = await new Promise<boolean>((resolve) => restartDialog.addEventListener("close", () => resolve(restartDialog.returnValue === "restart"), { once: true }));
    if (!replace) return;
    response = await send({ type: "PREPARE_START", batchId, tabId: tab.id, tabUrl: tab.url, settings, replaceResult: true });
  }
  if (!response.ok) return showNotice(response.code === "batch_active" ? "已有作用中批次，請先停止該批次。" : errorLabels[response.code as PreflightCode] || response.error || "無法開始批次。");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "START_BATCH", batchId, settings } satisfies Message);
  } catch {
    await send({ type: "CANCEL_PREPARE", batchId });
    showNotice("無法在目前分頁執行。請確認它是可存取的 Facebook 社團頁面。");
  }
  await refresh();
}

async function stopBatch(): Promise<void> {
  if (!currentState?.active) return;
  if (currentState.active.phase === "preflight") {
    const response = await send({ type: "CANCEL_PREPARE", batchId: currentState.active.batchId });
    if (!response.ok) showNotice("無法取消尚未開始的批次。");
    await refresh();
    return;
  }
  try { await chrome.tabs.sendMessage(currentState.active.tabId, { type: "STOP_BATCH" } satisfies Message); }
  catch { showNotice("無法聯絡來源分頁；批次會保留最近一次暫存結果。"); }
}

async function refresh(): Promise<void> {
  const response = await send({ type: "GET_STATE" });
  if (!response.ok) return;
  currentState = response.data as SessionState;
  render(currentState);
}

function render(state: SessionState): void {
  controls.classList.toggle("hidden", Boolean(state.active));
  status.classList.toggle("hidden", !state.active && !state.result);
  stop.classList.toggle("hidden", !state.active);
  $("go-source").classList.toggle("hidden", !state.active);
  if (state.lastError) showNotice(errorLabels[state.lastError]);
  if (state.active) {
    const labels = {
      preflight: "正在驗證頁面",
      scanning: "正在掃描",
      scrolling: "正在捲動",
      waiting_for_foreground: "背景分頁未前進，等待回到來源分頁",
    };
    $("phase").textContent = labels[state.active.phase];
    $("source").textContent = state.active.groupName || state.active.groupUrl;
    renderStats(state.active.stats);
    $("progress").textContent = `${state.active.stats.exported} / ${state.active.settings.targetPostCount}`;
    $("no-new").classList.remove("hidden");
    $("no-new").textContent = `未發現新貼文 ${state.active.noNewCount}/${state.active.settings.noNewScanLimit}`;
  } else if (state.result) {
    $("phase").textContent = reasonLabels[state.result.batch.stop_reason] || state.result.batch.stop_reason;
    $("source").textContent = state.result.batch.group_name || state.result.batch.group_url;
    $("progress").textContent = `${state.result.posts.length} 篇`;
    renderStats(state.result.batch.stats);
    $("no-new").classList.add("hidden");
  }
  result.classList.toggle("hidden", !state.result || Boolean(state.active));
  if (state.result && !state.active) renderResult(state.result);
}

function renderStats(stats: Stats): void {
  for (const key of ["scanned", "exported", "excluded", "duplicates", "failed"] as const) $(key).textContent = String(stats[key]);
  const reasons = stats.failed_by_reason;
  $("failure-details").textContent = stats.failed === 0
    ? ""
    : `失敗原因：未知卡片 ${reasons.unknown_card}、最低資料不足 ${reasons.minimum_data}、解析例外 ${reasons.exception}`;
  $("failure-details").classList.toggle("hidden", stats.failed === 0);
}

function renderResult(envelope: BatchEnvelope): void {
  $("result-status").textContent = envelope.batch.status;
  $("result-reason").textContent = reasonLabels[envelope.batch.stop_reason] || envelope.batch.stop_reason;
  const canExport = envelope.posts.length > 0;
  $<HTMLButtonElement>("json").disabled = !canExport;
  $<HTMLButtonElement>("csv").disabled = !canExport;
  if (!canExport) showNotice(`找不到支援的主貼文。已排除 ${envelope.batch.stats.excluded} 張卡片，解析失敗 ${envelope.batch.stats.failed} 張。`);
  renderPostPreview($("preview"), envelope.posts);
}

async function download(format: "json" | "csv"): Promise<void> {
  const envelope = currentState?.result;
  if (!envelope || envelope.posts.length === 0) return;
  const content = format === "json" ? serializeJson(envelope) : serializeCsv(envelope);
  const blob = new Blob([content], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: `${makeFilenameStem(envelope)}.${format}`, saveAs: true });
    await send({ type: "MARK_RESULT_HANDLED" });
  } catch { showNotice("下載失敗，批次結果仍保留在目前瀏覽器工作階段。"); }
  finally { window.setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}

async function discard(): Promise<void> {
  const response = await send({ type: "DISCARD_RESULT" });
  if (!response.ok) return showNotice(response.error || "無法捨棄目前批次結果。");
  await refresh();
}

async function goToSource(): Promise<void> {
  if (!currentState?.active) return;
  await chrome.tabs.update(currentState.active.tabId, { active: true });
}

function showNotice(message: string): void { notice.textContent = message; notice.classList.remove("hidden"); }
function hideNotice(): void { notice.classList.add("hidden"); notice.textContent = ""; }
function send(message: Message): Promise<AppResponse> { return chrome.runtime.sendMessage(message); }

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const original = parseBatchSettings(stored[SETTINGS_KEY]);
  const settings = parseStoredBatchSettings(stored[SETTINGS_KEY]);
  if (!settings) return;
  writeSettings(settings);
  if (original && !batchSettingsEqual(settings, original)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
}

function defaultSettings(): BatchSettings {
  return parseBatchSettings(DEFAULT_BATCH_SETTINGS)!;
}

function readSettings(): BatchSettings | null {
  return parseBatchSettings({
    targetPostCount: inputNumber("target-count"),
    maxDurationMinutes: inputNumber("max-duration-minutes"),
    noNewScanLimit: inputNumber("no-new-limit"),
    pacing: {
      cardDelayMinMs: inputNumber("card-delay-min"),
      cardDelayMaxMs: inputNumber("card-delay-max"),
      scrollDelayMinMs: inputNumber("scroll-delay-min"),
      scrollDelayMaxMs: inputNumber("scroll-delay-max"),
      noNewBackoffStepMs: inputNumber("backoff-step"),
      noNewBackoffMaxMs: inputNumber("backoff-max"),
      scrollDistanceMinPercent: inputNumber("scroll-percent-min"),
      scrollDistanceMaxPercent: inputNumber("scroll-percent-max"),
    },
  });
}

function writeSettings(settings: BatchSettings): void {
  const values: Record<string, number> = {
    "target-count": settings.targetPostCount,
    "max-duration-minutes": settings.maxDurationMinutes,
    "no-new-limit": settings.noNewScanLimit,
    "card-delay-min": settings.pacing.cardDelayMinMs,
    "card-delay-max": settings.pacing.cardDelayMaxMs,
    "scroll-delay-min": settings.pacing.scrollDelayMinMs,
    "scroll-delay-max": settings.pacing.scrollDelayMaxMs,
    "backoff-step": settings.pacing.noNewBackoffStepMs,
    "backoff-max": settings.pacing.noNewBackoffMaxMs,
    "scroll-percent-min": settings.pacing.scrollDistanceMinPercent,
    "scroll-percent-max": settings.pacing.scrollDistanceMaxPercent,
  };
  for (const [id, value] of Object.entries(values)) $<HTMLInputElement>(id).value = String(value);
}

function inputNumber(id: string): number {
  return Number($<HTMLInputElement>(id).value);
}
