import { PLAY_FORMATS, playFormatValues } from "./lib/listing-types.mjs";
import { durationMinutes, durationLabel, hourlyPrice, hourlyPriceLabel } from "./lib/session-values.mjs";
import { authorIdentity, buildSelectionCopy, listingDate, listingTime, MAX_SELECTED, MAX_COPY_CHARACTERS } from "./lib/selection.mjs";
import { filterRows } from "./lib/query-core.mjs";

export function browserPlan(values) {
  const all = [];
  const condition = (field, op, value) => ({ field, op, value });
  const dates = [];
  if (values.date) dates.push(condition("date", "eq", values.date));
  if (values.weekday !== "" && values.weekday !== undefined) dates.push({ any: [condition("weekday", "eq", Number(values.weekday)), condition("recurrence_weekdays", "contains", Number(values.weekday))] });
  if (dates.length) all.push({ [values.dateMode === "all" ? "all" : "any"]: dates });
  if (values.q?.trim()) all.push(condition("search_text", "includes_text", values.q.trim()));
  if (values.from) all.push(condition("start_time", "gte", values.from));
  if (values.region?.trim()) all.push({ any: ["city", "district"].map((field) => condition(field, "includes_text", values.region.trim())) });
  for (const [key, field] of [["venue", "venue_name"], ["skill", "skill_description"]]) if (values[key]?.trim()) all.push(condition(field, "includes_text", values[key].trim()));
  if (["true", "false"].includes(values.beginner)) all.push(condition("beginner_friendly", "eq", values.beginner === "true"));
  if (values.fee !== "" && values.fee !== undefined) all.push(condition("fee_min_twd", "lte", Number(values.fee)));
  if (values.play_format) all.push(condition("play_format", "in", playFormatValues(values.play_format)));
  if (values.status) all.push(condition("status", "eq", values.status));
  if (values.excludedAuthorUrls?.length) all.push({ any: [condition("author_url", "is_known", false), { all: values.excludedAuthorUrls.map(url => condition("author_url", "neq", url)) }] });
  return {
    interpretation: "場次頁面條件；價格採最低已列方案金額，其他條件仍須確認。",
    where: { all }, preferences: { beginner_friendly: null, max_fee_twd: null, require_contactable: false },
    include: { full: Boolean(values.full), cancelled: Boolean(values.cancelled), duplicates: Boolean(values.duplicates) },
  };
}

export function compareBrowserRows(a, b, sort = "time") {
  const compare = (x, y, descending = false) => {
    const missingX = x === null || x === undefined || x === "" || Number.isNaN(x);
    const missingY = y === null || y === undefined || y === "" || Number.isNaN(y);
    if (missingX || missingY) return Number(missingX) - Number(missingY);
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "zh-Hant")) * (descending ? -1 : 1);
  };
  if (sort === "fee") return compare(a.fee_min_twd === "" ? null : Number(a.fee_min_twd), b.fee_min_twd === "" ? null : Number(b.fee_min_twd)) || a.listing_id.localeCompare(b.listing_id);
  if (sort === "venue") return compare(a.venue_name, b.venue_name) || a.listing_id.localeCompare(b.listing_id);
  if (sort === "scraped") return compare(Date.parse(a.scraped_at), Date.parse(b.scraped_at), true) || a.listing_id.localeCompare(b.listing_id);
  const kind = (row) => row.date ? 0 : row.recurrence_weekdays ? 1 : 2;
  return kind(a) - kind(b) || compare(a.date, b.date, sort === "timeDesc")
    || compare(a.recurrence_weekdays, b.recurrence_weekdays, sort === "timeDesc")
    || compare(a.start_time, b.start_time, sort === "timeDesc")
    || compare(a.end_time ? `${a.end_day_offset ?? "0"}:${a.end_time}` : null, b.end_time ? `${b.end_day_offset ?? "0"}:${b.end_time}` : null, sort === "timeDesc")
    || a.listing_id.localeCompare(b.listing_id);
}

export function dateGroup(row) {
  return row.date ? `1:${row.date}` : row.recurrence_weekdays ? `0:${row.recurrence_weekdays}` : "2:unknown";
}

export function compareGroupedRows(a, b, field = "time", descending = false) {
  const groupA = dateGroup(a), groupB = dateGroup(b);
  if (groupA !== groupB) {
    const kind = groupA[0].localeCompare(groupB[0]);
    return kind || groupA.localeCompare(groupB) * (field === "date" && descending ? -1 : 1);
  }
  return compareUngroupedRows(a, b, field, descending);
}

export function compareUngroupedRows(a, b, field = "time", descending = false) {
  if (field === "date") {
    const kind = row => row.date ? 1 : row.recurrence_weekdays ? 0 : 2;
    const category = kind(a) - kind(b);
    const date = String(a.date || a.recurrence_weekdays || "").localeCompare(String(b.date || b.recurrence_weekdays || ""));
    return category || date * (descending ? -1 : 1) || compareBrowserRows(a, b, "time");
  }
  const keys = { venue: "venue_name", skill: "skill_description", play_format: "play_format", fee: "fee_min_twd", hourly_rate: "hourly_rate", status: "status", contact: "contactability", date: "date", time: "start_time" };
  const key = keys[field] ?? "start_time";
  const x = field === "duration" ? durationMinutes(a) : a[key], y = field === "duration" ? durationMinutes(b) : b[key];
  const missingX = x === "" || x == null, missingY = y === "" || y == null;
  const value = missingX || missingY ? Number(missingX) - Number(missingY) : (["fee", "duration", "hourly_rate"].includes(field) ? Number(x) - Number(y) : String(x).localeCompare(String(y), "zh-Hant")) * (descending ? -1 : 1);
  return value || compareBrowserRows(a, b, "time");
}

export function safeLink(url) {
  try { const parsed = new URL(url); return ["https:", "http:", "tel:"].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}

const warningLabels = {
  source_content_truncated: "來源本文截斷", missing_date: "日期未標示", missing_time: "時間不完整", missing_venue: "場地未標示",
  missing_price: "價格未公開", missing_skill: "程度未標示", missing_contact: "報名方式未標示", ambiguous_date: "日期有歧義",
  ambiguous_pairing: "時段或場地配對待確認", relative_date_unanchored: "相對日期缺少可信發布時間", source_conflict: "原文資訊互相衝突",
  insufficient_information: "資訊不足", recurrence_unconfirmed: "週期開團待確認", invalid_scraped_at: "擷取時間缺失或無效",
  fingerprint_identity: "僅能以內容指紋識別來源", not_recruitment: "非招生貼文",
};
function evidenceLabel(field) {
  const labels = { "schedule.date": "日期", "schedule.start_time": "開始時間", "schedule.end_time": "結束時間", "schedule.end_day_offset": "跨日",
    "venue.name": "場館", "venue.city": "城市", "venue.district": "行政區", "venue.address": "地址", "skill.description": "程度", "skill.min_level": "程度下限", "skill.max_level": "程度上限", "skill.beginner_friendly": "新手友善",
    "availability.status": "招生狀態", "availability.vacancies": "名額", "availability.capacity": "容量", "registration.line_id": "LINE", "registration.phone": "電話", "registration.instructions": "報名說明", court_count: "場數", shuttlecock: "用球" };
  if (labels[field]) return labels[field];
  if (field.startsWith("schedule.recurrence")) return "固定週期";
  if (field.startsWith("price_options")) return "價格方案與條件";
  if (field.startsWith("registration.methods")) return "報名方式";
  if (field.startsWith("amenities")) return "設施";
  return "原文證據";
}

export function mountBrowser(document = globalThis.document) {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text ?? "未標示");
    if (className) element.className = className;
    return element;
  };
  try {
    const { result, rows, csv } = JSON.parse($("session-data").textContent);
    if (result.schema_version !== "badminton-output-2" || !Array.isArray(rows) || !Array.isArray(result.listings) || rows.length !== result.listings.length) throw new Error("場次資料格式或版本不符，請重新發布");
    if (typeof csv !== "string") throw new Error("缺少同批 CSV");
    $("download-csv").href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    $("download-csv").download = `sessions-${result.publication_id}.csv`;
    const listingById = new Map(result.listings.map((listing) => [listing.listing_id, listing]));
    if (listingById.size !== rows.length || new Set(rows.map((row) => row.listing_id)).size !== rows.length || rows.some((row) => !listingById.has(row.listing_id))) throw new Error("場次集合不一致，請重新發布");
    $("published").textContent = `更新於 ${new Intl.DateTimeFormat("zh-TW", {timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(result.generated_at))}`;
    for (const row of rows) row.hourly_rate = hourlyPrice(listingById.get(row.listing_id));
    const selectedIds = new Set();
    const excludedAuthors = new Map();
    const anonymousIds = new Set((result.source_posts ?? []).filter(post => post.raw?.is_anonymous).map(post => post.id));
    const authorById = new Map(result.listings.map(listing => [listing.listing_id, authorIdentity(listing, anonymousIds.has(listing.source_post_id))]));
    const values = () => ({ full: true, cancelled: true,
      excludedAuthorUrls: [...new Set(result.listings.filter(listing => excludedAuthors.has(authorById.get(listing.listing_id))).map(listing => listing.source.author_url))], ...Object.fromEntries([...$("filters").querySelectorAll("input,select")].map((input) => [input.id, input.type === "checkbox" ? input.checked : input.value])) });
    const appendLink = (parent, url, label) => {
      const href = safeLink(url);
      if (!href) return;
      const link = node("a", label); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; parent.append(link);
    };
    function appendSourceLinks(parent, listing) {
        for (const [url, label] of [[listing.source.post_url, "原貼文"], [listing.source.author_url, "作者頁"]]) {
          const href = safeLink(url);
          if (href && /^https?:/.test(href)) appendLink(parent, href, `${label} ↗`);
          else { const unavailable = node("span", `${label} ↗`, "unavailable-link"); unavailable.setAttribute("aria-disabled", "true"); unavailable.title = "未提供網址"; parent.append(unavailable); }
        }
    }
    const view = document.defaultView;
    let activeAuthor = null;
    function closeAuthor(restoreFocus = false) {
      if (!activeAuthor) return;
      const {trigger, popup} = activeAuthor;
      popup.hidden = true; trigger.setAttribute("aria-expanded", "false"); activeAuthor = null;
      if (restoreFocus) trigger.focus();
    }
    document.addEventListener("click", event => {
      if (activeAuthor && !activeAuthor.trigger.contains(event.target) && !activeAuthor.popup.contains(event.target)) closeAuthor();
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeAuthor(true); });
    function updateScrollNavigation() {
      const root = document.documentElement;
      const maximum = Math.max(0, root.scrollHeight - view.innerHeight);
      $("scroll-top").hidden = view.scrollY <= 1;
      $("scroll-bottom").hidden = maximum <= 1 || view.scrollY >= maximum - 1;
      const barHeight = $("selection-bar").hidden ? 0 : $("selection-bar").getBoundingClientRect().height;
      $("scroll-navigation").style.bottom = `${barHeight + 16}px`;
    }
    view.addEventListener("scroll", () => { closeAuthor(); updateScrollNavigation(); }, {passive:true});
    view.addEventListener("resize", () => { closeAuthor(); updateScrollNavigation(); });
    let scrollFrame = null;
    const cancelJump = () => { if (scrollFrame !== null) view.cancelAnimationFrame(scrollFrame); scrollFrame = null; };
    view.addEventListener("wheel", cancelJump, {passive:true});
    view.addEventListener("touchstart", cancelJump, {passive:true});
    for (const [id, bottom] of [["scroll-top", false], ["scroll-bottom", true]]) {
      $(id).addEventListener("click", () => {
        cancelJump();
        const target = bottom ? Math.max(0, document.documentElement.scrollHeight - view.innerHeight) : 0;
        if (view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { view.scrollTo({top:target, behavior:"instant"}); return; }
        const start = view.scrollY, started = view.performance.now();
        const step = now => {
          const progress = Math.min(1, (now - started) / 180);
          view.scrollTo({top:start + (target-start) * (1-Math.pow(1-progress,3)), behavior:"instant"});
          scrollFrame = progress < 1 ? view.requestAnimationFrame(step) : null;
        };
        scrollFrame = view.requestAnimationFrame(step);
      });
    }
    if (view.ResizeObserver) {
      const observer = new view.ResizeObserver(updateScrollNavigation);
      observer.observe(document.body); observer.observe($("selection-bar"));
    }
    let grouped = false;
    const sorts = { grouped: { field:null, descending:false }, flat: { field:null, descending:false } };
    function render() {
      closeAuthor();
      const controls = values();
      const { field:sortField, descending } = sorts[grouped ? "grouped" : "flat"];
      const selected = filterRows(rows, browserPlan(controls)).sort((a, b) => (grouped ? compareGroupedRows : compareUngroupedRows)(a, b, sortField ?? (grouped ? "time" : "date"), descending));
      $("summary").textContent = `${selected.length} / ${rows.length} 場${selected.length ? "" : "；沒有符合條件的場次，可清除條件或開啟重複場次。"}`;
      $("view-grouped").setAttribute("aria-pressed", String(grouped));
      $("view-flat").setAttribute("aria-pressed", String(!grouped));
      $("session-table").classList.toggle("grouped", grouped);
      $("rows").replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const button of document.querySelectorAll("[data-sort]")) {
        const active = button.dataset.sort === sortField;
        button.parentElement.setAttribute("aria-sort", active ? (descending ? "descending" : "ascending") : "none");
        button.textContent = button.dataset.label + (active ? (descending ? " ▼" : " ▲") : " ↕");
      }
      const groupCounts = new Map();
      for (const row of selected) groupCounts.set(dateGroup(row), (groupCounts.get(dateGroup(row)) ?? 0) + 1);
      let previousGroup = null;
      for (const row of selected) {
        const group = dateGroup(row);
        if (grouped && group !== previousGroup) {
          const heading = node("tr", undefined, "date-group");
          const cell = node("th", (row.date ? `${row.date.replace(/-/g, " / ")} · 週${"日一二三四五六"[new Date(row.date + "T00:00:00Z").getUTCDay()]}` : null) || (row.recurrence_weekdays ? `每週${row.recurrence_weekdays.split(/[|,]/).map(day => "日一二三四五六"[Number(day)]).join("、")}（開團日期需確認）` : "日期未定"));
          cell.append(node("span", `${groupCounts.get(group)} 場`, "date-count"));
          cell.colSpan = 8; cell.scope = "rowgroup"; heading.append(cell); fragment.append(heading); previousGroup = group;
        }
        const listing = listingById.get(row.listing_id);
        const tr = node("tr"); tr.dataset.listingId = row.listing_id;
        const cell = (label, text, className) => { const td = node("td", undefined, className); if (text !== undefined) td.append(node("span", text, "cell-value")); td.dataset.label = label; tr.append(td); return td; };
        tr.classList.toggle("is-selected", selectedIds.has(row.listing_id));
        tr.tabIndex = 0;
        tr.setAttribute("aria-selected", String(selectedIds.has(row.listing_id)));
        tr.setAttribute("aria-label", `${listingDate(listing)} ${listingTime(listing)} ${listing.venue.name || "場次"}，按 Enter 或空白鍵切換選取`);
        const toggleSelection = () => {
          if (!selectedIds.has(row.listing_id) && selectedIds.size >= MAX_SELECTED) { $("selection-message").textContent = `最多選取 ${MAX_SELECTED} 場，請先移除部分場次。`; return; }
          selectedIds.has(row.listing_id) ? selectedIds.delete(row.listing_id) : selectedIds.add(row.listing_id);
          tr.classList.toggle("is-selected", selectedIds.has(row.listing_id));
          tr.setAttribute("aria-selected", String(selectedIds.has(row.listing_id)));
          renderSelection();
      updateScrollNavigation();
        };
        tr.addEventListener("click", event => {
          if (event.target.closest(".contact-details,a,button,input,select,textarea,summary,details,[contenteditable],[aria-disabled]")) return;
          if (document.defaultView.getSelection()?.toString()) return;
          toggleSelection();
        });
        tr.addEventListener("keydown", event => {
          if (event.target !== tr || !["Enter", " "].includes(event.key) || event.repeat) return;
          event.preventDefault(); toggleSelection();
        });
        if (!grouped) cell("日期", listingDate(listing).replace("（日期需確認）", ""), "row-date");
        cell("時間", listingTime(listing), "time");
        cell("場館／地區", [listing.venue.name || "場館未標示", listing.venue.city, listing.venue.district, listing.venue.address].filter(Boolean).join(" · "));
        cell("玩法", PLAY_FORMATS[listing.play_format] || "", "play-format");
        const skill = cell("程度");
        const skillValue = node("div", undefined, "cell-value");
        skillValue.append(node("div", listing.skill.description || "程度未標示"));
        skillValue.append(node("div", `用球：${listing.shuttlecock?.trim() || "未標示"}`, "shuttlecock"));
        skill.append(skillValue);
        cell("時數", durationLabel(listing.schedule), "duration");
        const price = cell("費用（元）", undefined, "price");
        price.append(node("span", row.fee_min_twd, "fee-amount"));
        cell("每小時費用", hourlyPriceLabel(listing), "hourly-rate");
        const detailCell = cell("聯絡與原文", undefined, "detail");
        const links = node("div", undefined, "links primary-links");
        appendSourceLinks(links, listing);
        const contactLine = node("div", undefined, "contact-line"); contactLine.append(links); detailCell.append(contactLine);
        const author = node("div", undefined, "author-line");
        const authorKey = authorById.get(row.listing_id);
        if (authorKey) {
          const trigger = node("button", listing.source.author_name || "作者未標示", "author-name author-trigger");
          trigger.type = "button"; trigger.setAttribute("aria-expanded", "false");
          trigger.title = "作者過濾選項";
          const popup = node("div", undefined, "author-popover"); popup.hidden = true; popup.id = `author-${row.listing_id}`;
          trigger.setAttribute("aria-controls", popup.id);
          trigger.addEventListener("click", () => {
            const wasOpen = activeAuthor?.trigger === trigger; closeAuthor();
            if (wasOpen) return;
            popup.hidden = false; trigger.setAttribute("aria-expanded", "true"); activeAuthor = {trigger, popup};
            const rect = trigger.getBoundingClientRect();
            popup.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - popup.offsetWidth - 8))}px`;
            popup.style.top = `${rect.bottom + popup.offsetHeight + 8 <= view.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - popup.offsetHeight - 4)}px`;
          });
          const exclude = node("button", "過濾此作者", "subtle-button"); exclude.type = "button"; exclude.dataset.excludeAuthor = authorKey;
          exclude.addEventListener("click", () => { excludedAuthors.set(authorKey, listing.source.author_name || "未命名作者"); render(); });
          popup.append(exclude); author.append(trigger, popup);
        } else author.append(node("span", listing.source.author_name || "作者未標示", "author-name"));
        contactLine.append(author);
        const contactText = [listing.registration.line_id ? `LINE：${listing.registration.line_id}` : null, listing.registration.phone ? `電話：${listing.registration.phone}` : null].filter(Boolean);

        const details = node("div", undefined, "contact-details"); details.hidden = true; details.id = `details-${row.listing_id}`;
        const toggle = node("button", "詳情與原文 ▸", "text-button details-toggle"); toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", details.id);
        toggle.addEventListener("click", () => {
          details.hidden = !details.hidden;
          toggle.setAttribute("aria-expanded", String(!details.hidden));
          toggle.textContent = details.hidden ? "詳情與原文 ▸" : "詳情與原文 ▾";
        });
        author.append(toggle);
        if (listing.source.stale) details.append(node("p", "來源已有新版，整理尚未更新", "warning"));
        if (row.dedupe_status !== "unique") details.append(node("p", row.dedupe_status === "duplicate" ? "確定重複" : "可能重複，請比對來源", "warning"));
        if (listing.play_format) details.append(node("p", `玩法：${PLAY_FORMATS[listing.play_format]}`));
        details.append(node("p", `費用條件：${listing.price_display}`));
        details.append(node("p", [listing.registration.instructions, ...contactText].filter(Boolean).join(" · ") || "報名方式未標示"));
        appendLink(details, listing.source.post_url, "原貼文");
        details.append(node("p", `擷取：${listing.source.scraped_at || "未知"}；觀察：${listing.source.observation_id ?? "未關聯歷史庫"}；最新觀察：${listing.source.latest_observation_id ?? "未知"}`));
        const original = node("pre", listing.raw_text);
        const postHref = safeLink(listing.source.post_url);
        if (postHref) {
          const originalLink = node("a", undefined, "original-post"); originalLink.href = postHref; originalLink.target = "_blank"; originalLink.rel = "noopener noreferrer";
          originalLink.setAttribute("aria-label", "開啟這篇 Facebook 原貼文"); originalLink.append(original); details.append(originalLink);
        } else details.append(original);
        const warnings = [...new Set([...listing.quality.warnings, ...listing.source.warnings])];
        if (warnings.length) details.append(node("p", `需留意：${warnings.map((code) => warningLabels[code] ?? code).join("；")}`, "warning"));
        if (listing.notes.length) details.append(node("p", listing.notes.join("；")));
        if (listing.quality.evidence.length) {
          details.append(node("p", "欄位原文證據"));
          const evidence = node("ul");
          const seen = new Set();
          for (const item of listing.quality.evidence) {
            const label = `${evidenceLabel(item.field)}：${item.quote}`;
            if (!seen.has(label)) { evidence.append(node("li", label)); seen.add(label); }
          }
          details.append(evidence);
        }
        for (const id of [listing.dedupe.duplicate_of, ...listing.dedupe.candidate_ids].filter(Boolean)) {
          const candidate = listingById.get(id); if (candidate) appendLink(details, candidate.source.post_url, `比對來源 ${candidate.source.author_name ?? id}`);
        }
        detailCell.append(details); fragment.append(tr);
      }
      $("rows").append(fragment);
      $("condition-filters").replaceChildren();
      const labels = [
        ["q", controls.q.trim() ? `搜尋：${controls.q.trim()}` : null],
        ["beginner", controls.beginner ? `新手友善：${$("beginner").selectedOptions[0].textContent}` : null],
        ["play_format", controls.play_format ? `玩法：${$("play_format").selectedOptions[0].textContent}` : null],
        ["fee", controls.fee !== "" ? `費用 ≤ ${controls.fee} 元` : null],
        ["from", controls.from ? `${controls.from} 起（含）` : null],
        ["date", controls.date ? `日期：${controls.date}` : null],
        ["weekday", controls.weekday !== "" ? $("weekday").selectedOptions[0].textContent : null],
        ["dateMode", controls.date && controls.weekday !== "" && controls.dateMode === "all" ? "日期與星期：同時符合兩項" : null],
        ["duplicates", controls.duplicates ? "包含重複" : null],
      ];
      for (const [id, label] of labels) {
        if (!label) continue;
        const chip = node("button", `${label} ×`, "filter-chip"); chip.type = "button"; chip.dataset.clearFilter = id;
        chip.setAttribute("aria-label", `取消條件：${label}`);
        chip.addEventListener("click", () => {
          if (id === "duplicates") $(id).checked = false;
          else $(id).value = id === "dateMode" ? "any" : "";
          render(); $(id).focus();
        });
        $("condition-filters").append(chip);
      }
      $("author-filters").replaceChildren();
      for (const [key, name] of excludedAuthors) {
        const chip = node("button", `排除作者：${name} ×`, "author-chip"); chip.type = "button";
        chip.setAttribute("aria-label", `取消排除作者 ${name}`);
        chip.addEventListener("click", () => { excludedAuthors.delete(key); render(); }); $("author-filters").append(chip);
      }
      renderSelection();
      updateScrollNavigation();
    }
    function renderSelection() {
      const chosen = [...selectedIds].map(id => listingById.get(id));
      $("selection-panel").hidden = !chosen.length; $("selection-bar").hidden = !chosen.length;
      $("copy-fallback").hidden = true; $("copy-text").value = "";
      const payload = buildSelectionCopy(chosen);
      $("selection-count").textContent = `已選 ${chosen.length} / ${MAX_SELECTED} 場 · ${payload.characters.toLocaleString()} / ${MAX_COPY_CHARACTERS.toLocaleString()} 字元`;
      $("copy-selection").disabled = !payload.withinLimit;
      $("selection-message").textContent = payload.withinLimit ? "" : "內容超過 100,000 字元，請移除部分場次後再複製。原文不會被截斷。";
      $("selection-rows").replaceChildren();
      for (const listing of chosen) {
        const contactText = [listing.registration.instructions, listing.registration.line_id && `LINE：${listing.registration.line_id}`, listing.registration.phone].filter(Boolean).join(" · ");
        const card = node("article", undefined, "selection-card");
        const heading = node("div", undefined, "selection-heading");
        heading.append(node("h3", `${listingDate(listing)} · ${listingTime(listing)} · ${listing.venue.name || "場館未標示"}`));
        const remove = node("button", "移除", "text-button"); remove.type = "button";
        remove.setAttribute("aria-label", `移除 ${listing.venue.name || "場次"} ${listingDate(listing)}`);
        remove.addEventListener("click", () => { selectedIds.delete(listing.listing_id); render(); }); heading.append(remove); card.append(heading);
        const facts = node("dl", undefined, "selection-facts");
        const venue = [listing.venue.name, listing.venue.city, listing.venue.district, listing.venue.address].filter(Boolean).join(" · ");
        for (const [label, value] of [["場館／地址", venue || "未標示"], ["時數", durationLabel(listing.schedule)], ["費用條件", listing.price_display], ["每小時費用", hourlyPriceLabel(listing)], ["玩法", PLAY_FORMATS[listing.play_format] || "未標示"], ["程度", listing.skill.description || "未標示"], ["報名方式", contactText || "未標示"], ["作者", listing.source.author_name || "未標示"]]) {
          facts.append(node("dt", label), node("dd", value));
        }
        card.append(facts);
        const contact = node("div", undefined, "links selection-links");
        appendSourceLinks(contact, listing);
        card.append(contact);
        if (excludedAuthors.has(authorById.get(listing.listing_id))) card.append(node("p", "已排除此作者；此場仍保留於選取清單", "warning"));
        const details = node("details"); details.open = true; details.append(node("summary", "原文"), node("pre", listing.raw_text || "未提供原文")); card.append(details);
        $("selection-rows").append(card);
      }
    }
    $("clear-selection").addEventListener("click", () => { selectedIds.clear(); render(); });
    $("copy-selection").addEventListener("click", async () => {
      const payload = buildSelectionCopy([...selectedIds].map(id => listingById.get(id)));
      if (!selectedIds.size || !payload.withinLimit) return;
      try {
        await document.defaultView.navigator.clipboard.writeText(payload.text);
        $("selection-message").textContent = `已複製 ${payload.characters.toLocaleString()} 字元（含 ${payload.sourceCount} 篇原文）`;
      } catch {
        $("copy-fallback").hidden = false; $("copy-text").value = payload.text; $("copy-text").focus(); $("copy-text").select();
        $("selection-message").textContent = "瀏覽器未允許直接複製，請在文字框按 ⌘C 或 Ctrl+C。";
      }
    });
    for (const button of document.querySelectorAll("[data-sort]")) button.addEventListener("click", () => {
      const sort = sorts[grouped ? "grouped" : "flat"];
      if (sort.field !== button.dataset.sort) { sort.field = button.dataset.sort; sort.descending = false; }
      else if (!sort.descending) sort.descending = true;
      else { sort.field = null; sort.descending = false; }
      render();
    });
    $("view-grouped").addEventListener("click", () => { grouped = true; render(); });
    $("view-flat").addEventListener("click", () => { grouped = false; render(); });
    $("filters").addEventListener("submit", (event) => event.preventDefault());
    $("filters").addEventListener("input", render);
    $("filters").addEventListener("change", render);
    $("filters").addEventListener("reset", () => { excludedAuthors.clear(); grouped = false; sorts.grouped = {field:null,descending:false}; sorts.flat = {field:null,descending:false}; queueMicrotask(render); });
    $("export-plan").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(browserPlan(values()), null, 2)], { type: "application/json" }));
      const anchor = node("a"); anchor.href = url; anchor.download = "query.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    render();
    return { render, plan: () => browserPlan(values()) };
  } catch (error) {
    $("error").hidden = false; $("error").textContent = `載入失敗：${error.message}`;
    return null;
  }
}
