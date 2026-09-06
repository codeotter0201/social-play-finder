# 羽球場次整理與搜尋 Skill 實作計畫

> 封存紀錄：僅供追溯當時背景，不代表目前行為。現行入口見[文件索引](../README.md)。

## 1. 決策摘要

把目前的 `scripts/badminton-recruitment/` 流程重構成一個完整、可直接面對使用者需求的 skill，暫定名稱為 `badminton-session-finder`。它提供兩種模式，但共用同一份資料契約：

1. **整理模式**：讀取一或多份 Facebook 社團下載 JSON，由 scripts 先把 raw data 整理成每筆都有穩定 ID 的來源資料，再抽出只有 `{id, context}` 的任務交給 LLM 分析，最後依 ID join 回完整來源資料，輸出 `output_result.json` 與 `output_result.csv`。
2. **搜尋模式**：讀取整理後的 CSV，將使用者的自然語言需求轉成明確篩選條件，輸出少量、排序過、可以直接聯絡的場次，並視需要另存完整篩選 CSV。

這不是再疊一層 prompt。skill 必須同時定義：資料所有權、LLM 與程式的責任邊界、輸出 schema、篩選語意、聯絡可用性、回答格式和驗收案例。

核心產品要求：

- JSON 是無損標準輸出；CSV 是一列一場次、可搜尋且可獨立使用的檢視。
- ID 必須由 scripts 在送進 LLM 前建立；LLM 只回傳相同 ID 與分析結果。
- join 必須依 ID 執行，不能依陣列順序、檔案順序或 LLM 回傳順序對應。
- 原始 JSON 已有的欄位不得交給 LLM 重抄或改寫。
- 所有網址由程式從原始資料直接保留、分類和輸出，LLM 不生成、修補或正規化網址。
- 搜尋結果的目標不是「列出符合的資料列」，而是讓使用者看完就能決定要不要報名，喜歡時能立即開啟原文、作者頁面、LINE、電話或報名連結。
- 不再把 `FB私訊`、`未標示` 當成足夠的最終答案。

## 2. 現況問題

目前流程已能抽取場次，但輸出契約和搜尋呈現沒有以「下一步能否聯絡」為中心。

| 現況 | 使用者問題 | 必須修正 |
|---|---|---|
| CSV 只有 `skill_min`、`skill_max` | 「不限程度」「初階友善但需懂規則」等語意遺失 | 加入完整 `skill_description` |
| CSV 只有 `registration_methods` | `facebook_message` 最後只顯示成「FB私訊」，沒有入口 | 同列保留作者、原文、報名網址及可點擊的主要聯絡入口 |
| JSON 有 `author_url`，CSV 沒有 | 貼文沒有 `post_url` 時，即使有作者頁面也無法聯絡 | CSV 必須加入 `author_url`，並作為私訊 fallback |
| CSV 沒有 `registration.instructions` 和 `registration.url` | 「點頭貼報名」「留言時附程度」等操作指引遺失 | 加入 `registration_instructions`、`registration_url` |
| 費用空值顯示為「未標示」 | 使用者不知道是資料壞掉，還是原文未公開 | 顯示「原文未公開，請聯絡確認」，並保留聯絡入口 |
| 搜尋直接輸出數十列 | 重複、疑似重複與資訊不完整場次混在一起 | 先篩選、分組、排序，再輸出預設 10 筆可行動結果 |
| `possible_duplicate` 不是全留就是全丟 | 可能漏掉不同團主，也可能讓同一場出現多次 | 以場次群組呈現，將不同價格／聯絡來源列為同場變體 |
| 日期、週期與時間條件沒有說明套用方式 | 「9/2 or 週三 18 點以前」可能有多種解釋 | 回答前先產生並顯示一行「本次篩選解讀」 |

目前的失敗例子：

```text
15:00–18:00  秘密基地羽球館  不限程度  未標示  FB私訊
```

目標輸出至少要能變成：

```text
9/2（三）15:00–18:00｜秘密基地羽球館（板橋）
程度：不限程度，新手／初學者可參加
費用：原文未公開，報名前請確認
報名：開啟原貼文留言，或前往作者 Mi Nnie 的頁面私訊
聯絡：[原貼文] [作者頁面]
適合原因：符合週三、18:00 前開打及不限程度
```

若原始資料真的沒有任何貼文網址、作者網址、LINE、電話或報名連結，結果應標示「無直接聯絡入口」，降低排序並放到「資訊不足」區，而不是假裝 `FB私訊` 已經可以使用。

## 3. 使用者工作流

### 3.1 整理下載資料

典型要求：

```text
整理這四份下載 JSON，合併成一份 output result。
```

skill 應執行：

1. 接受一或多個明確的 JSON 路徑。
2. 驗證每份輸入含 `batch` 與 `posts[]`，記錄來源檔名，不更動原檔。
3. 由 `prepare.mjs` 將 raw data 整理成 `source_records.json`，為每個 batch 和 post 建立 collision-checked ID，同時完整保留原始結構化欄位與網址。
4. 由同一支 script 產生 `llm_tasks.jsonl`；每筆只能有 `id` 和 `context` 兩個頂層欄位。
5. LLM 逐筆讀取 `{id, context}`，回傳 `{id, analysis}`；一篇貼文可以分析出零至多筆場次。
6. `join.mjs` 驗證 ID 一對一完整對應，再把 analysis join 回 `source_records.json`；不得依資料順序合併。
7. `finalize.mjs` 從 join 後資料建立 listing ID、衍生欄位、聯絡入口、重複標記及品質資訊。
8. 產出同一資料夾下的：
   - `source_records.json`：有 ID、完整保留 raw data 的中間資料。
   - `llm_tasks.jsonl`：只含 `{id, context}` 的 LLM 輸入。
   - `llm_results.jsonl`：只含 `{id, analysis}` 的 LLM 回傳。
   - `joined_records.json`：依 ID join 完成的可稽核資料。
   - `output_result.json`：無損、可追溯的標準輸出。
   - `output_result.csv`：一列一場次的搜尋檢視。
   - `run_report.json`：處理篇數、失敗篇數、警告、重複統計和未完成任務。
9. 回覆檔案路徑、筆數、品質摘要；不能只說「完成」。

若使用者同時要求整理與搜尋，先完成整理，再直接對新產生的 CSV 執行搜尋，不要求使用者重新下指令。

### 3.2 從 CSV 找適合場次

典型要求：

```text
幫我找 9/2 或固定週三、18:00 以前開打，適合初階、300 元內，而且要能直接聯絡的場次。
```

skill 應執行：

1. 確認 CSV 具有 skill 要求的必要欄位。
2. 將需求轉成結構化查詢計畫，保留 AND／OR 群組，不以關鍵字湊條件。
3. 用確定性程式對 CSV 篩選、分組和排序。
4. 排除 `duplicate`、`full`、`cancelled`；除非使用者明確要求查看。
5. 將 `possible_duplicate` 合併為同場變體，不靜默刪除。
6. 預設優先顯示具有直接聯絡入口的結果。
7. 回覆本次條件解讀、符合筆數、前 10 個結果及完整篩選 CSV 路徑。
8. 每個結果都要包含日期／週期、時間、地區與場館、程度、價格、報名方式、可點擊入口及符合原因。

## 4. Skill 入口與模式路由

### 4.1 建議名稱與 description

```yaml
name: badminton-session-finder
description: Convert exported Facebook badminton recruitment JSON into traceable structured listings, and find actionable sessions from the resulting CSV by date, weekday, time, location, level, fee, availability, or contact method. Use when users ask to organize or merge badminton recruitment exports, or ask which sessions fit their needs and how to contact the organizer.
```

維持可自動觸發，不設 explicit-only。以下要求都應命中：

- 整理、合併、結構化羽球招生下載 JSON。
- 產生或修正羽球場次 JSON／CSV。
- 從 CSV 找指定日期、星期、時段、地區、程度或預算的場次。
- 比較場次並提供可實際使用的聯絡方式。

不應因一般 CSV 整理、其他運動活動或單純 Facebook 擷取問題而觸發。

### 4.2 模式判斷

- 輸入含 `.json` 原始批次，或要求「整理／合併／轉 output」：整理模式。
- 輸入含 `.csv`，或要求「找／篩選／推薦／適合我的場次」：搜尋模式。
- 同時出現 raw JSON 與搜尋目的：串接兩種模式。
- 只提供自然語言、沒有檔案路徑：先尋找對話中最近產生的 `output_result.csv`；找不到才詢問一個明確路徑。

### 4.3 查詢預設語意

- 「18:00 以前」預設指 `start_time <= 18:00`，包含 18:00；回答必須明說。
- 「18:00 前結束」才使用 `end_time <= 18:00`。
- 「9/2 或週三，18:00 前」預設為 `(date=9/2 OR recurrence 含週三) AND start_time<=18:00`。
- 「9/2，或週三 18:00 前」若逗號和上下文造成範圍明顯歧義，應先顯示預計解讀；只有結果集合會大幅不同時才問一句澄清。
- 「週三」同時匹配 `recurrence_weekdays` 含 3 的每週三與明確日期落在週三的場次；結果需區分「本次日期」和「固定週三」。
- 沒有指定結果數時預設 10 筆，不把完整數十列貼到對話中。

## 5. Skill 套件結構

實作時建立真正的 skill 套件，將現有流程移入並取代舊入口，不長期維護兩套實作：

```text
skills/badminton-session-finder/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/
│   ├── extraction-mode.md
│   ├── search-mode.md
│   ├── output-contract.md
│   ├── result-format.md
│   ├── extraction.schema.json
│   └── query.schema.json
├── scripts/
│   ├── prepare.mjs
│   ├── join.mjs
│   ├── finalize.mjs
│   ├── dedupe.mjs
│   ├── links.mjs
│   ├── csv.mjs
│   ├── query.mjs
│   └── validate.mjs
└── tests/
    ├── extraction.test.mjs
    ├── links.test.mjs
    ├── query.test.mjs
    └── fixtures/
```

責任分配：

- `SKILL.md`：只保留模式路由、共同不變條件、執行入口與該讀哪份 reference。
- `extraction-mode.md`：貼文語意抽取規則與 LLM 邊界。
- `search-mode.md`：自然語言查詢、篩選、分組和排序規則。
- `output-contract.md`：標準 JSON、CSV 欄位和來源追溯規則。
- `result-format.md`：使用者可行動的回答卡片格式與反例。
- `scripts/`：網址、來源合併、驗證、CSV、查詢、排序與去重等確定性工作。
- `tests/fixtures/`：小型、去識別化但保留真實語法的貼文和查詢案例。

完成搬移後：

- 更新 `package.json`、根 README 和文件連結。
- 移除被取代的舊 `README.md`、`prompt.md` 與舊路徑；不保留另一套相同用途的實作。
- 以 repo 內 skill 目錄作為唯一來源，安裝到 Codex skill 目錄時採部署／連結方式，不複製出另一份需人工同步的內容。

## 6. 資料責任邊界

### 6.1 程式直接處理

以下資料不得交給 LLM 重抄：

- 每筆 batch、post 和 listing 的 ID；ID 一律由 scripts 建立。
- `batch` 全部欄位。
- 貼文的 `post_id`、`post_url`、`author_name`、`author_url`。
- `published_at`、`published_time_raw`、`scraped_at`。
- 互動數、是否匿名、是否置頂、是否截斷、來源 warnings。
- `media[]` 及其 URL。
- `group_id`、`group_name`、`group_url`。
- 來源檔名、來源貼文索引、穩定 ID。
- 所有網址的保留、分類、正規化、CSV escaping。
- fee min/max、顯示文字、聯絡可用性、搜尋字串、排序分數和 dedupe。

`prepare.mjs` 必須先產生可獨立保存的來源資料：

```json
{
  "batches": [
    {
      "id": "batch id created by script",
      "source_file": "來源檔",
      "raw": "原始 batch object"
    }
  ],
  "posts": [
    {
      "id": "post id created by script",
      "batch_id": "對應 batch id",
      "source_post_index": 0,
      "raw": "原始 post object",
      "links": "程式整理的網址清單"
    }
  ]
}
```

ID 必須穩定、可重跑、可檢查碰撞。即使 raw post 沒有 `post_id` 或 `post_url`，仍要由來源批次識別、來源內容指紋和來源索引建立 ID。LLM 不得建立或修改 ID。

### 6.2 LLM 只處理非結構化語意

送給 LLM 的每筆資料只能有兩個頂層欄位：

```json
{
  "id": "post id created by script",
  "context": {
    "text": "已移除實際網址、只保留語意上下文的貼文內容",
    "reference_time": "原始 scraped_at",
    "timezone": "Asia/Taipei",
    "is_truncated": false
  }
}
```

LLM 回傳：

```json
{
  "id": "完全照抄輸入 id",
  "analysis": {
    "is_recruitment": true,
    "listings": [],
    "warnings": []
  }
}
```

除了 `id` 之外，LLM 不接收也不回傳任何來源識別欄位。`author_name`、`post_url`、`author_url`、group 資料和 raw metadata 都在 join 時由 script 接回。

- 是否為羽球招生貼文。
- 同篇貼文包含哪些獨立場次，以及日期／週期和時間的正確配對。
- 場館名稱、貼文明寫的地址與區域。
- 價格方案及條件。
- 程度原文、可推導的級數範圍、新手友善與否。
- 招募狀態、缺額、總人數、場數、用球、設施。
- 報名方式種類、LINE ID、電話與操作說明。
- 欄位證據、信心和歧義警告。

LINE ID 和電話若由 LLM 抽取，join／finalizer 必須驗證該值可在原文找到；找不到時拒絕該值並加警告。網址不在 LLM analysis schema 內。

### 6.3 網址處理規則

`links.mjs` 建立每篇貼文的 deterministic link inventory：

- `group_url`：直接來自 batch／post。
- `post_url`：直接來自 post。
- `author_url`：直接來自 post。
- `media_urls[]`：直接來自 `media[]`。
- `inline_urls[]`：只從原始文字中可解析的完整網址取得。
- `registration_urls[]`：依明確網域或原始欄位分類，例如 `line.me`、`lin.ee`、外部報名頁；無法判定時保留在 `inline_urls[]`，不猜用途。

原始網址和值要保留。如果需要正規網址，另存 `canonical_url`，不能覆蓋 `raw_url`。LLM 回傳任何網址欄位都視為 schema 錯誤。

產生 `llm_tasks.jsonl` 時，`context.text` 內的完整網址要先由 script 抽出並存入 link inventory，再以 `〔網址已由程式保留〕` 取代。LLM 可以判讀周圍文字是否在描述報名，但不看、不複製、不修改實際網址。

不得根據 Facebook user ID 自行組出未擷取過、未驗證的 Messenger 或 `m.me` 網址。只有 `author_url` 時，顯示為「開啟作者頁面私訊」，不能聲稱是直接訊息連結。

## 7. 標準輸出契約

### 7.1 `output_result.json`

JSON 是無損資料來源，首層直接保存產生時間、來源資料、場次與統計：

```json
{
  "generated_at": "ISO-8601",
  "source_batches": [
    {
      "source_file": "/absolute/or/user-provided/path.json",
      "batch": "原始 batch object，欄位與值不改寫"
    }
  ],
  "source_posts": [
    {
      "id": "post id created by script",
      "batch_id": "batch id created by script",
      "source_file": "來源檔",
      "source_post_index": 0,
      "raw": "原始 post object，欄位與值不改寫",
      "links": "程式建立的 link inventory",
      "analysis": {
        "is_recruitment": true,
        "listings": [],
        "warnings": []
      }
    }
  ],
  "listings": [
    {
      "listing_id": "deterministic id",
      "source_post_id": "join 後的 post id reference",
      "title": null,
      "team_name": null,
      "schedule": {},
      "venue": {},
      "price_options": [],
      "skill": {},
      "availability": {},
      "registration": {},
      "contact": {},
      "quality": {},
      "dedupe": {}
    }
  ],
  "stats": {}
}
```

要求：

- `source_batches[].batch` 與 `source_posts[].raw` 必須能和輸入逐欄位比較相等。
- `source_posts[].analysis` 必須由相同 `id` 的 LLM result join 而來。
- listing 只用 `source_post_id` 連回原文，不重複製造一份可能漂移的來源資料。
- `contact` 是程式根據 registration + link inventory 建立的可行動檢視，不是 LLM 自由文字。
- `quality` 保存 confidence、warnings、evidence 與 truncated 狀態。
- 所有未知值保留 `null`，不能用推測補齊。

### 7.2 `output_result.csv`

CSV 是搜尋與人工選場用途，至少要有以下欄位。

來源與追溯：

```text
listing_id
source_post_id
source_file
batch_id
group_id
group_name
group_url
source_post_index
post_id
post_url
author_name
author_url
published_at
published_time_raw
scraped_at
content_is_truncated
source_warnings
```

場次與語意：

```text
date
recurrence_weekdays
start_time
end_time
timezone
title
team_name
venue_name
address
city
district
status
vacancies
capacity
court_count
shuttlecock
amenities
skill_description
skill_min
skill_max
beginner_friendly
price_options_json
fee_min_twd
fee_max_twd
price_display
```

聯絡與報名：

```text
registration_methods
registration_instructions
line_id
phone
registration_urls
primary_contact_method
primary_contact_label
primary_contact_url
contactability
contact_links_json
```

品質與搜尋：

```text
confidence
warnings
dedupe_status
duplicate_of
dedupe_candidates
dedupe_match_reasons
raw_text
search_text
```

其中：

- `skill_description` 必須保留「不限程度」「謝絕新手」「需懂規則」等完整語意。
- `price_display` 由程式產生。無費用時使用「原文未公開，請聯絡確認」，不是空白或「未標示」。
- `registration_instructions` 保留「點我頭貼」「留言附程度」等操作方式。
- `primary_contact_*` 依下列順序選擇：外部報名連結、LINE、電話、原貼文、作者頁面。
- `contactability` 使用固定 enum：
  - `direct`：有報名連結、LINE 或電話。
  - `source`：可開啟原貼文留言，或有作者頁面可私訊。
  - `partial`：有來源入口，但報名方式不明。
  - `unavailable`：完全沒有可用連結、ID 或電話。
- `contact_links_json` 保存所有可用入口，不因 primary 選擇而丟失。
- CSV 維持 UTF-8 BOM、標準 escaping 與試算表公式注入防護。

## 8. 整理模式實作流程

```text
raw JSON files
  -> prepare.mjs
       -> source_records.json（完整 raw + script IDs + links）
       -> llm_tasks.jsonl（只有 {id, context}）
  -> LLM
       -> llm_results.jsonl（只有 {id, analysis}）
  -> join.mjs（嚴格依 id join）
       -> joined_records.json
  -> finalize.mjs（derived fields + contact + dedupe）
  -> output_result.json + output_result.csv + run_report.json
```

### 8.1 任務準備

- scripts 先為每個 batch 和 post 建立全域唯一 ID，不能只用合併後陣列索引。
- `source_records.json` 保存完整 raw data、來源檔、ID 和 link inventory。
- `llm_tasks.jsonl` 每行只能有 `{id, context}`；`context` 只放完成語意判讀需要的文字、參考時間、時區與截斷狀態。
- raw metadata、作者、群組、media 和實際網址不得進入 task。
- 每篇一個獨立結果；支援批次執行和中斷續跑。
- LLM result 每行只能有 `{id, analysis}`，且 id 必須完全等於輸入 id。

### 8.2 ID join

`join.mjs` 是唯一允許把 LLM analysis 接回來源資料的地方：

- 以 `source_records.posts[].id` 建立 lookup map。
- 拒絕 LLM result 中不存在於來源資料的 ID。
- 拒絕相同 ID 出現兩次。
- 預設拒絕任何缺少 analysis 的來源 ID；只有使用者明確接受部分結果時才允許繼續，並記錄在 run report。
- LLM 回傳順序可以任意打亂，join 結果仍必須相同。
- join 後保留來源 record 原值，analysis 只新增在獨立欄位，不能覆蓋 `raw`、`links`、`source_file` 或來源索引。
- analysis 中每筆 listing 在 finalize 時取得 `source_post_id`，再產生自己的 listing ID。

### 8.3 驗證與失敗可見性

- 以完整 JSON Schema validator 驗證，不只檢查少數必填欄位。
- 缺少 ID、未知 ID、重複 ID、缺少結果、evidence 不存在於原文、LINE／電話不是原文子字串，都要列入 `run_report.json`。
- 預設不能在部分 LLM 任務失敗時安靜產生看似完整的 output；若使用者接受部分結果，output 與報告都要標記 `partial`。
- `content_is_truncated=true` 時保留場次，但降低品質並顯示 `source_content_truncated`。
- 非招生貼文保留在 `source_posts`，只是沒有 listing，確保來源筆數可核對。

### 8.4 去重

- 明確 `duplicate` 不進入一般搜尋結果，但仍留在標準 JSON／CSV。
- `possible_duplicate` 不直接刪除。
- 新增穩定 `event_group_id`，供搜尋時將相同日期／週期、時間和場地聚成一張卡片。
- 同場不同團主、程度、價格或聯絡方式作為 variants 呈現。
- 分組不改寫來源 listing，也不會選一筆覆蓋其他筆。

## 9. 搜尋模式設計

### 9.1 查詢計畫

LLM 只把自然語言轉成符合 `query.schema.json` 的計畫，例如：

```json
{
  "where": {
    "all": [
      {
        "any": [
          { "field": "date", "op": "eq", "value": "2026-09-02" },
          { "field": "recurrence_weekdays", "op": "contains", "value": 3 }
        ]
      },
      { "field": "start_time", "op": "lte", "value": "18:00" }
    ]
  },
  "preferences": {
    "beginner_friendly": true,
    "max_fee_twd": 300,
    "require_contactable": true
  },
  "limit": 10
}
```

`query.mjs` 負責實際運算。LLM 不直接逐列讀 CSV 後憑印象挑資料，也不能自己改寫日期、價格或聯絡網址。

查詢計畫必須另外輸出一行人類可讀說明，例如：

```text
篩選解讀：2026/9/2 或固定週三，開始時間不晚於 18:00（包含 18:00）；優先顯示 300 元內、初階可參加且可直接聯絡的場次。
```

### 9.2 硬篩選與偏好

硬篩選：

- 明確日期、固定星期。
- 開始／結束時間上下限。
- 城市、行政區、場館。
- open／full／cancelled 狀態。
- 費用上限（只有使用者用「一定」「不要超過」等硬性語氣時）。
- 明確要求可直接 LINE、電話或報名連結。

偏好排序：

- 程度相符、新手友善。
- 價格已知且落在預算內。
- `contactability=direct` 優於 `source`、`partial`、`unavailable`。
- 場次資料完整、confidence 較高。
- 招募狀態 open 優於 unknown。
- 貼文來源較新。

未知值不能被當成符合。例如使用者硬性要求「300 元內」，沒有價格的場次不能混入主要符合結果；可另列「費用待確認」。

### 9.3 分組與排序

1. 先排除 `duplicate`、已滿與取消。
2. 執行硬篩選。
3. 依 `event_group_id` 分組。
4. 每組彙整不同來源的價格、程度和聯絡入口。
5. 計算偏好分數，但回答必須使用人類可理解的符合原因，不能只顯示分數。
6. 排序優先序：日期／週期適用性、開始時間、聯絡可用性、程度、價格、confidence。
7. 預設回傳 10 組，另輸出完整 filtered CSV。

## 10. 最終回答契約

每次搜尋回答分成三部分：

1. 一行篩選解讀。
2. 最符合的場次卡片或精簡表格。
3. 完整篩選 CSV 連結及資料不足摘要。

每張卡片至少包含：

```text
日期／週期 + 時間
場館 + 行政區／地址
程度完整說明
費用完整說明
招募狀態／缺額（有資料時）
報名操作說明
至少一個可用聯絡入口
為何符合使用者需求
```

聯絡欄的標準呈現：

- 有外部報名網址：`[直接報名](...)`。
- 有 LINE ID：`LINE ID: abc123`；如果原文有 LINE URL，再加 `[開啟 LINE](...)`。
- 有電話：`電話：09xx...`。
- 有 post URL：`[開啟原貼文留言／查看最新狀態](...)`。
- 只有 author URL：`[開啟作者 Name 的頁面私訊](...)`。
- 完全沒有入口：`無直接聯絡入口；不列入主要推薦`。

費用未知時：

```text
費用：原文未公開，請透過上方聯絡方式確認
```

不能只寫：

```text
未標示｜FB私訊
```

若沒有任何符合且可聯絡的場次，應清楚區分：

- 沒有符合硬條件。
- 有符合場次，但費用／程度待確認。
- 有符合資料，但沒有可用聯絡入口。

## 11. 實作順序

### 階段 A：鎖定契約與 fixture

- 從現有真實輸出挑選小型匿名化 fixture，涵蓋多時段、固定週期、價格條件、LINE、電話、post URL 缺失但 author URL 存在、完全無聯絡入口。
- 先寫 source records、LLM task、LLM analysis、join output、CSV 欄位表及 query schema。
- 為「秘密基地羽球館／不限程度／點頭貼私訊」建立回歸案例。

### 階段 B：重構整理管線

- `prepare.mjs` 先建立 IDs、source records 和 deterministic link inventory。
- 產生只有 `{id, context}` 的 LLM tasks；context 中的實際網址先抽離。
- LLM 只回傳 `{id, analysis}`。
- `join.mjs` 嚴格按 ID join，驗證 unknown／duplicate／missing ID。
- 從 LLM schema 移除 URL。
- 使用完整 schema validation 和 evidence／identifier 驗證。
- 產生 JSON、CSV、run report。

### 階段 C：建立搜尋引擎

- 實作 query plan validator。
- 實作 AND／OR、日期／週期、時間、地點、程度、價格、狀態和聯絡條件。
- 實作 event grouping、contactability 與排序。
- 實作 filtered CSV 輸出。

### 階段 D：完成 skill 文件

- 寫精簡 `SKILL.md` 路由兩種模式。
- 將詳細規則放到 references。
- 產生 `agents/openai.yaml`。
- 更新 package scripts 與 repo 文件入口。

### 階段 E：移除舊入口與驗收

- 所有呼叫端切換到新路徑。
- 移除舊 prompt／README／重複 schema，不留另一套相同用途的實作。
- 對真實四份下載資料跑一次完整整理和搜尋 smoke test。
- 驗證結果能直接開啟原貼文或作者頁面，不再出現只有「FB私訊」而沒有入口的主要推薦。

## 12. 測試與品質門檻

### 12.1 整理管線

- 每個輸入 batch 和 post 的原始結構化欄位，在輸出 JSON 中逐欄位相等。
- 每個 `llm_tasks.jsonl` record 的頂層只能是 `id` 與 `context`。
- 每個 `llm_results.jsonl` record 的頂層只能是 `id` 與 `analysis`。
- 將 LLM results 任意洗牌後，join output 必須完全相同。
- unknown ID、duplicate ID 和 missing ID 都必須被拒絕並清楚報告。
- 所有 raw URL 原值逐字保留；canonical URL 只能存在於另一欄。
- `context` 不得包含 raw data 中的完整 URL 值。
- LLM schema 不接受 URL 欄位。
- 同篇多場次能正確配對，不做日期與時間的笛卡兒積。
- 價格條件、程度描述、報名 instructions 能進入 CSV。
- LLM 缺漏結果或非法結果使執行失敗，或在使用者明確接受時產生 `partial` 報告。
- CSV 通過逗號、換行、引號、中文與公式注入測試。

### 12.2 搜尋

- `9/2 or 禮拜3 下午18點以前` 產生正確的 OR 群組與 `start_time <= 18:00`。
- 「18 點前結束」改用 `end_time`。
- `duplicate` 不進入主結果，`possible_duplicate` 被分組而非直接消失。
- 費用硬上限不把未知費用當成符合。
- 新手查詢不推薦明寫「不收新手」的場次。
- 有 LINE／電話／報名網址的結果排在只有來源連結者之前。
- 有 `author_url` 的 Facebook 私訊場次必須輸出作者連結。
- 只有 `FB私訊` 字樣但沒有任何入口的資料，不得進入主要推薦。
- 預設最多 10 組，完整資料存在 filtered CSV。

### 12.3 Skill 驗證

- 執行 `quick_validate.py` 驗證 skill 結構和 frontmatter。
- 執行所有 Node 單元與整合測試。
- 執行至少兩個獨立行為案例：一個 raw JSON 整理，一個 CSV 自然語言找場。
- 最後執行專案既有 `npm run check`，不得降低現有檢查。

## 13. 完成定義

以下條件全部成立才算完成：

- 使用者只提供下載 JSON 路徑，就能得到完整 `output_result.json`、`output_result.csv` 和執行報告，不需要知道 prepare／finalize 細節。
- 原始結構化資料與網址完整保留，URL 全程不由 LLM 生成。
- CSV 保留程度全文、價格說明、報名 instructions、作者與原文網址。
- 使用者提供自然語言目的後，skill 能清楚說明篩選解讀並回傳排序過的可行動場次。
- 每個主要推薦至少有一個實際可用的聯絡入口；沒有入口的資料被清楚降級。
- 「秘密基地羽球館 15:00–18:00」案例不再輸出成 `不限程度／未標示／FB私訊`，而會附費用待確認說明、作者名稱、作者網址及有的話原貼文網址。
- 舊流程被新 skill 完整取代，沒有需要同步維護的另一套實作。
- skill validation、單元測試、整合測試與專案檢查全部通過。

## 14. 非目標

- 不修改 Facebook 擷取器本身，也不重新抓取網頁。
- 不登入 Facebook、代替使用者傳訊、留言或報名。
- 不自行查詢場館、補地址、補價格或確認貼文是否仍有效。
- 不從 user ID 猜測 Messenger URL。
- 不把 CSV 當成無損來源；需要完整追溯時永遠回到 `output_result.json`。
