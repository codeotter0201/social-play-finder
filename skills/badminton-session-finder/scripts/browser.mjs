import { PLAY_FORMATS } from "./lib/listing-types.mjs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseCsv } from "./lib/csv.mjs";

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[char]);
}

export async function buildBrowser(result, csv, outputPath, { datasets = [] } = {}) {
  const heading = result.dataset ? `${result.dataset.name}場次` : "羽球場次";
  const navigation = datasets.length ? `<nav class="dataset-navigation" aria-label="地區"><a href="../index.html">所有地區</a>${datasets.map(dataset => `<a href="../${encodeURIComponent(dataset.id)}/index.html"${dataset.id === result.dataset?.id ? ' aria-current="page"' : ""}>${escapeHtml(dataset.name)}</a>`).join("")}</nav><p class="dataset-note">地區依來源資料集分類；實際地點請查看場館資訊。</p>` : "";
  const bundled = await build({
    stdin: { contents: 'import { mountBrowser } from "./browser-runtime.mjs"; mountBrowser();', resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2020",
  });
  const data = JSON.stringify({ result, rows: parseCsv(csv).rows, csv }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const favicon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="51" text-anchor="middle" font-size="52">🏸</text></svg>');
  const script = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  await writeFile(outputPath, `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(heading)}瀏覽</title><link rel="icon" type="image/svg+xml" href="${favicon}">
<style>
:root { --ink:#20342d; --muted:#748078; --line:#e3e9e5; --accent:#217254; --paper:#fafbf9; }
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.6 system-ui,-apple-system,sans-serif; overflow-wrap:anywhere; }
.page { max-width:1480px; margin:auto; padding:40px 32px 64px; }
header { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:28px; }
h1 { margin:0; font-size:25px; font-weight:650; letter-spacing:.03em; }
.dataset-navigation { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:8px; }
.dataset-navigation a { padding:6px 12px; border:1px solid var(--line); border-radius:7px; text-decoration:none; }
.dataset-navigation a[aria-current] { background:var(--accent); color:white; }
.dataset-note { font-size:12px; color:var(--muted); margin:0 0 24px; }
.brand-icon { display:inline-block; margin-right:10px; font-size:26px; vertical-align:-2px; }
header p { margin:4px 0 0; font-size:12px; color:var(--muted); }
a { color:var(--accent); text-underline-offset:4px; }
a,button,summary { cursor:pointer; }
button,input,select { font:inherit; color:inherit; }
button,input,select { border:1px solid #d8e1da; border-radius:7px; background:white; }
input,select { width:100%; min-width:0; height:40px; padding:8px 10px; }
/* iOS native date/time appearance can override border-box and intrinsic sizing. */
input[type=date],input[type=time] { -webkit-appearance:none; appearance:none; box-sizing:border-box; min-inline-size:0; max-width:100%; text-align:left; }
input[type=date]::-webkit-date-and-time-value,input[type=time]::-webkit-date-and-time-value { display:block; min-height:22px; line-height:22px; padding:0; text-align:left; }
input[type=checkbox] { width:auto; height:auto; accent-color:var(--accent); }
button { padding:8px 12px; }
button:hover { background:#eef4ef; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
label { display:block; min-width:0; font-size:12px; color:var(--muted); }
label input,label select { display:block; margin-top:5px; font-size:14px; color:var(--ink); }
.filters { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:16px; }
.filters label { grid-column:span 3; }
.filters label:first-child { grid-column:span 5; }
.filters label:nth-child(2),.filters label:nth-child(3) { grid-column:span 2; }
.filters label:nth-child(4) { grid-column:span 3; }
.text-button { padding:0; border:0; background:transparent; color:var(--muted); font-size:13px; }
.controls { display:flex; flex-wrap:wrap; align-items:center; gap:16px; padding-top:16px; }
.controls label { display:flex; align-items:center; gap:6px; white-space:nowrap; }
.controls input { margin:0; }
#summary { color:var(--muted); font-size:13px; margin:0; }
.results-toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin:24px 0 12px; }
.view-switch { display:inline-flex; padding:3px; border:1px solid var(--line); border-radius:8px; }
.view-switch button { border:0; background:transparent; padding:5px 12px; color:var(--muted); font-size:13px; }
.view-switch button[aria-pressed="true"] { color:var(--accent); background:#eaf1eb; }
.row-date { font-size:13px; font-weight:400; color:var(--muted); }
#error { color:#9c3417; }
.table-wrap { border:1px solid var(--line); border-radius:9px; overflow:hidden; background:white; }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
#session-table col.date-col { width:8%; } #session-table col.time-col { width:15%; }
#session-table col.venue-col { width:15%; } #session-table col.skill-col { width:10%; }
#session-table col.play-format-col { width:5%; }
#session-table col.duration-col { width:7%; } #session-table col.fee-col { width:7%; } #session-table col.hourly-rate-col { width:9%; } #session-table col.contact-col { width:24%; }
#session-table.grouped .date-col, #session-table.grouped .row-date { display:none; }
#session-table.grouped .date-heading { display:none; }
[hidden] { display:none !important; }
#rows tr[data-listing-id] { cursor:pointer; transition:background-color 160ms ease,box-shadow 160ms ease; }
#rows tr.is-selected,#rows tr.is-selected:hover { background:#e8f3ea; box-shadow:inset 3px 0 var(--accent); }
#rows tr[data-listing-id]:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
@media(prefers-reduced-motion:reduce) { #rows tr[data-listing-id] { transition:none; } }
#active-filters { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
#active-filters:has(#condition-filters:empty):has(#author-filters:empty) { display:none; }
#condition-filters,#author-filters { display:contents; }
#author-filters:empty { display:none; }
.filter-chip,.author-chip { background:transparent; border:1px solid var(--line); border-radius:6px; padding:5px 9px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; text-align:left; }
.filter-chip:hover,.author-chip:hover { border-color:#a8bcb0; color:var(--accent); background:#f0f5f1; }
#selection-panel { scroll-margin-top:20px; margin-top:40px; padding-bottom:120px; }
#selection-panel h2 { font-size:20px; }
.selection-card { background:white; border:1px solid var(--line); border-radius:8px; padding:16px; margin-top:12px; }
.selection-heading { display:flex; justify-content:space-between; gap:16px; }
.selection-heading h3 { font-size:14px; font-weight:600; margin:0 0 8px; }
#selection-bar { position:fixed; bottom:0; left:0; right:0; padding:12px 24px; border-top:1px solid var(--line); background:white; z-index:5; box-shadow:0 -4px 20px #20342d0b; }
.selection-actions { display:flex; align-items:center; justify-content:center; gap:16px; flex-wrap:wrap; }
#copy-selection { background:var(--accent); color:white; }
#copy-selection:disabled { opacity:.5; cursor:not-allowed; }
#selection-message { text-align:center; margin:8px 0 0; font-size:12px; }
#selection-message:empty { display:none; }
#copy-fallback { margin:16px auto; max-width:1100px; }
#copy-text { width:100%; height:150px; font:12px/1.5 monospace; }
body:has(#selection-bar:not([hidden])) { padding-bottom:100px; }
th,td { padding:15px 12px; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); }
thead th { background:#fff; padding:13px 12px; color:var(--muted); font-size:12px; font-weight:500; }
th button { display:inline-flex; align-items:center; white-space:nowrap; border:0; padding:0; background:transparent; font-size:inherit; }
thead th.duration-heading,thead th.fee-heading,thead th.hourly_rate-heading { text-align:right; }
.date-group th { padding:9px 18px; background:#f0f4f0; color:#52665a; font-size:13px; font-weight:600; }
.date-count { margin-left:12px; font-size:12px; font-weight:400; color:var(--muted); }
tr[data-listing-id]:hover { background:#fcfdfb; }
.time { white-space:normal; overflow-wrap:anywhere; font-weight:600; font-variant-numeric:tabular-nums; }
.row-date,.time,.duration,.price,.hourly-rate { white-space:nowrap; }
.shuttlecock { margin-top:4px; color:var(--muted); font-size:12px; white-space:normal; overflow-wrap:anywhere; }
.duration { text-align:right; font-variant-numeric:tabular-nums; }
.hourly-rate { text-align:right; font-variant-numeric:tabular-nums; }
.contact-line { display:flex; align-items:center; gap:10px; }
.contact-line .primary-links { flex-shrink:0; }
.contact-line .author-line { min-width:0; margin:0; }
.price { text-align:right; font-variant-numeric:tabular-nums; }
.links { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.links a { text-decoration:none; font-size:13px; font-weight:600; color:var(--accent); }
.primary-links { flex-wrap:nowrap; gap:12px; min-height:22px; }
.primary-links a,.unavailable-link { font-size:13px; white-space:nowrap; }
.unavailable-link { font-weight:600; color:#9aa49e; cursor:default; }
.author-line { display:flex; align-items:center; gap:6px; margin-top:5px; color:var(--muted); font-size:12px; }
.subtle-button { flex-shrink:0; padding:2px 6px; border:1px solid var(--line); border-radius:5px; background:transparent; color:var(--muted); font-size:12px; line-height:20px; white-space:nowrap; }
.subtle-button:hover,.subtle-button[aria-expanded="true"] { border-color:#a8bcb0; background:#f0f5f1; color:var(--accent); }
.subtle-button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.author-trigger { border:0; padding:0; background:transparent; color:var(--accent); font:inherit; text-align:left; }
.author-trigger:hover { text-decoration:underline; text-underline-offset:3px; }
.author-popover { position:fixed; z-index:12; padding:5px; border:1px solid var(--line); border-radius:7px; background:white; box-shadow:0 4px 16px #20342d18; }
.author-popover button { border:0; }
.author-popover a { display:block; padding:8px 12px; border-radius:7px; font-size:14px; text-decoration:none; }
.author-popover a:hover { background:#eef4ef; }
#scroll-navigation { position:fixed; right:16px; bottom:16px; z-index:10; display:flex; flex-direction:column; gap:6px; }
#scroll-navigation button { width:40px; height:40px; padding:0; border:1px solid var(--line); border-radius:50%; background:#fffffff2; color:var(--accent); font-size:20px; box-shadow:0 2px 8px #20342d12; }
#scroll-navigation button:hover { background:#edf3ee; border-color:#a8bcb0; }
#scroll-navigation button:focus-visible,.author-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.author-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.links a:hover { text-decoration:underline; }
.contact-text { margin:4px 0 0; font-size:12px; color:var(--muted); }
.contact-details { margin-top:5px; }
.contact-details p { margin:8px 0; font-size:13px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; background:#f5f7f3; padding:12px; border-radius:6px; }
.original-post { display:block; }
.warning { color:#996534; } .muted { color:var(--muted); }
.download { font-size:13px; text-decoration:none; white-space:nowrap; }
.table-note { color:var(--muted); font-size:12px; margin:0 0 14px; }
.selection-facts { display:grid; grid-template-columns:90px minmax(0,1fr); gap:8px 16px; margin:12px 0; font-size:13px; }
.selection-facts dt { color:var(--muted); }
.selection-facts dd { margin:0; }
.selection-links { margin:14px 0; gap:16px; }
.selection-links a,.selection-links .unavailable-link { display:inline-flex; align-items:center; min-height:36px; padding:4px 8px; font-size:13px; border-radius:5px; }
.selection-links a:hover { background:#f0f5f1; }
.details-toggle { flex-shrink:0; font-size:12px; white-space:nowrap; line-height:24px; }
.details-toggle:hover { background:transparent; color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
@media(max-width:900px) {
 .page { padding:24px 16px 40px; } .filters { grid-template-columns:repeat(2,minmax(0,1fr)); }
 .filters label:nth-child(n) { grid-column:auto; } .filters label:first-child { grid-column:1/-1; }
 .contact-line { flex-wrap:wrap; }
 th,td { padding-left:12px; padding-right:12px; }
}
@media(max-width:640px) {
 header { margin-bottom:20px; } h1 { font-size:22px; } .filters { grid-template-columns:1fr 1fr; gap:12px; } .filters label:first-child { grid-column:1/-1; }
 .table-wrap { border:0; border-radius:0; background:transparent; }
 table,tbody,tr,td { display:block; } colgroup { display:none; }
 thead,thead tr { display:flex; flex-wrap:wrap; gap:14px; } thead th { padding:0 0 12px; border:0; background:transparent; }
 tr[data-listing-id] { background:white; border:1px solid var(--line); border-radius:7px; padding:12px 14px; margin:8px 0; }
 td { display:grid; grid-template-columns:88px minmax(0,1fr); gap:12px; padding:6px 0; border:0; text-align:left; white-space:normal; } td:before { content:attr(data-label); font-size:12px; font-weight:400; color:var(--muted); }
 .cell-value { min-width:0; overflow-wrap:anywhere; }
 .duration,.price,.hourly-rate { text-align:left; } .detail:before { display:none; } .detail { display:block; border-top:1px solid var(--line); margin-top:9px; padding-top:10px; }
 .date-group th { display:block; background:transparent; border:0; padding:16px 0 4px; }
}
</style></head><body><div class="page"><header><div><h1><span aria-hidden="true" class="brand-icon">🏸</span>${escapeHtml(heading)}</h1><p id="published"></p></div><a class="download" id="download-csv" download>下載 CSV ↓</a></header>${navigation}
<form id="filters"><section class="filters">
<label>搜尋<input id="q" type="search" placeholder="地區、場館、程度、關鍵字"></label>
<label>玩法<select id="play_format"><option value="">全部玩法</option>${Object.entries(PLAY_FORMATS).map(([value, label]) => `<option value="${value}">${label}${["doubles","singles"].includes(value) ? "（全部）" : ""}</option>`).join("")}</select></label>
<label>新手友善<select id="beginner"><option value="">不限</option><option value="true">適合新手</option><option value="false">非新手</option></select></label>
<label>費用上限（元）<input id="fee" type="number" min="0" placeholder="依最低方案篩選"></label>
<label>最早開始時間<input id="from" type="time" title="顯示此時間（含）之後開始的場次"></label>
<label>日期<input id="date" type="date"></label>
<label>星期<select id="weekday"><option value="">全部</option>${["日", "一", "二", "三", "四", "五", "六"].map((day, index) => `<option value="${index}">星期${day}</option>`).join("")}</select></label>
<label>日期與星期符合方式<select id="dateMode" title="日期與星期皆有設定時適用"><option value="any">符合其中一項</option><option value="all">同時符合兩項</option></select></label>
</section><div class="controls"><label><input id="duplicates" type="checkbox">包含重複</label><button class="text-button" id="export-plan" type="button">匯出查詢設定</button>
<button class="text-button" id="clear" type="reset">清除條件</button></div><div id="active-filters" aria-label="已套用的篩選條件"><div id="condition-filters"></div><div id="author-filters" aria-label="排除作者條件"></div></div></form>
<p id="error" role="alert" hidden></p><div class="results-toolbar"><div id="summary" role="status" aria-live="polite"></div><div class="view-switch" role="group" aria-label="場次顯示方式"><button type="button" id="view-grouped" aria-pressed="false">日期分組</button><button type="button" id="view-flat" aria-pressed="true">不分組</button></div></div><main><p class="table-note" id="table-hint">點擊場次可選取比較，再次點擊取消。費用為最低已列方案，條件請見詳情。固定週期場次請向主揪確認日期。</p><div class="table-wrap"><table id="session-table"><colgroup><col class="date-col"><col class="time-col"><col class="venue-col"><col class="play-format-col"><col class="skill-col"><col class="duration-col"><col class="fee-col"><col class="hourly-rate-col"><col class="contact-col"></colgroup><thead><tr>${[["date","日期"],["time","時間"],["venue","場館／地區"],["play_format","玩法"],["skill","程度"],["duration","時數"],["fee","費用（元）"],["hourly_rate","每小時費用"]].map(([key,label]) => `<th scope="col" class="${key}-heading" aria-sort="none"><button type="button" data-sort="${key}" data-label="${label}">${label} ↕</button></th>`).join("")}<th scope="col">聯絡與原文</th></tr></thead><tbody id="rows"></tbody></table></div>
<section id="selection-panel" hidden aria-label="已選場次比較"><h2>已選場次</h2><div id="selection-rows"></div></section>
</main></div>
<aside id="selection-bar" hidden aria-label="選取操作"><div class="selection-actions"><span id="selection-count"></span><button id="copy-selection" type="button">複製內容</button><button id="clear-selection" type="button" class="text-button">清空選取</button></div><p id="selection-message" role="status" aria-live="polite"></p><div id="copy-fallback" hidden><label for="copy-text">手動複製（全文已選取）</label><textarea id="copy-text" readonly></textarea></div></aside>
<nav id="scroll-navigation" aria-label="頁面跳轉"><button id="scroll-top" type="button" aria-label="回到頂部" title="回到頂部" hidden>↑</button><button id="scroll-bottom" type="button" aria-label="前往底部" title="前往底部" hidden>↓</button></nav>
<script type="application/json" id="session-data">${data}</script><script>${script}</script></body></html>`, "utf8");
  return outputPath;
}
