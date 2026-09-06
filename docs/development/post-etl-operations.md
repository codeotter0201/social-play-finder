# 貼文整理操作、升級與恢復

這個流程在既有 archive SQLite 保存原始觀察與逐篇抽取任務，沿用 prepare、join 的驗證及 finalize。模型可透過人工 JSONL 交接，或以已登入的 Codex CLI 執行抽取。正式頁面是每次發布產生的單一表格，資料包含完整已發布集合。

## 擷取與匯入

先依[專案首頁](../../README.md#開發)安裝依賴並執行 npm run build，再載入擴充功能：

1. 開啟 chrome://extensions，啟用「開發人員模式」。
2. 選擇「載入未封裝項目」，指向專案 dist/。後續重新建置後，需在此重新載入擴充功能。
3. 登入 Facebook，開啟目標社團的主要動態牆，從工具列開啟擴充功能。
4. 設定篇數目標、時限與捲動節奏，按「開始擷取」。可按「停止」保留已擷取結果；關閉 popup 不會清除批次。
5. 完成後按「下載 JSON」。抽取與歷史庫匯入使用原始 JSON；擴充功能的 CSV 是原始貼文檢視，不是整理後的場次表。

檔名包含可辨識的社團名稱、社團識別與擷取觸發時間；名稱無法可靠取得時省略。Facebook 頁面結構變動可能影響擷取，先檢查本文、來源與失敗原因數量，再執行後續處理。

以下命令從專案根目錄執行，將 /path/to/raw.json 換成實際下載檔案。可提供多個檔案；同一套流程請使用相同 --db 路徑。

```sh
npm run archive -- import /path/to/raw.json --db result/facebook-posts.sqlite
npm run archive -- latest --db result/facebook-posts.sqlite --limit 50
npm run archive -- history --db result/facebook-posts.sqlite --url 'https://www.facebook.com/groups/.../posts/.../'
```

接著依下節 prepare、extract，最後檢查發布：

```sh
npm run badminton -- validate --run result/sessions
```

extract 指定 --out 後會發布結果；若只執行人工交接，需依「人工 JSONL 交接」另行 publish。頁面使用者只需收到發布的 index.html，操作方式見[網站使用指南](../user-guide.md)。

## 自動抽取設定

專案的 [codex-model.json](../../skills/badminton-session-finder/codex-model.json) 保存 `gpt-5.6-sol`、`model_reasoning_effort=low`、`service_tier=priority`（fast）。這是專案呼叫設定，不改使用者全域 Codex 預設；使用既有 Codex 登入，不需要在專案填 API Key。

```sh
npm run badminton -- prepare --db result/facebook-posts.sqlite --model-config skills/badminton-session-finder/codex-model.json --out result/my-handoff
npm run badminton -- etl extract --db result/facebook-posts.sqlite --run result/my-handoff --out result/sessions --batch-size 50 --max-attempts 3
```

若只整理指定 raw 批次，prepare 加 `--batch-ids <batch_id,batch_id,...>`；它選這些批次出現的貼文 key，再從歷史庫選各 key 的最新觀察。extract 發布範圍取自本次 handoff；獨立 publish 可加 `--run result/my-handoff` 使用相同範圍。

extract 依序分批呼叫以下 Codex 指令，必要語意規則與 `{id,context}` 由 stdin 傳入；schema 透過 `--output-schema` 傳入，版本及模型設定保留於本機，不在提示重複傳送，沒有多 agent 並行：

```sh
codex -a never exec --ignore-user-config --ephemeral -s read-only --skip-git-repo-check \
  -m gpt-5.6-sol -c 'model_reasoning_effort="low"' -c 'service_tier="priority"' \
  -C <本批工作目錄> --output-schema <本批回應schema.json> -o <本批response.json> --json -
```

工作目錄 `codex/` 保存每批實際指令、任務、模型回應、CLI 事件與逐篇驗證報告；`codex_progress.json` 每 15 秒更新等待狀態、批次經過秒數及最後 CLI 事件時間；心跳只表示主程序存活，不代表模型已完成貼文。Codex 的回應格式 schema 只做供應端相容轉換；結果仍須通過目前抽取 schema、日期／時間／名額一致性與聯絡值檢查，驗證不會放寬。

成功任務不再呼叫模型；本次發生的驗證失敗會附具體錯誤重試，總嘗試上限預設 3、最多可設 5。既有失敗任務需 `--retry-failed` 才納入。單批逾時會保留失敗紀錄並在同一總嘗試上限內重試；認證、模型設定及其他傳輸或 CLI 執行失敗會記錄並停止，不會對其餘貼文反覆空跑。

```sh
# 保留成功結果，續跑待處理與失敗任務
npm run badminton -- etl extract --db result/facebook-posts.sqlite --run result/my-handoff --out result/sessions --retry-failed --max-attempts 3
```

若程序被強制中止，先確認 `codex-extract.lock` 記錄的 PID 已結束，移除該殘留鎖，再依下方 recover 流程重排處理中任務。`--limit <篇數>` 可用於先跑小批驗證；不會把尚未抽取的貼文當作已完成。

## 人工 JSONL 交接

先將實際使用的模型與設定存成自己的 `model.json`，例如下列格式；`model` 應填實際模型識別，`version` 是這組設定的版本，不放憑證。溫度或 reasoning 等設定若有使用也要保存，整個物件都會參與版本雜湊。

```json
{"model":"實際使用的模型名稱","version":"設定版本1","mode":"manual-jsonl"}
```

```sh
npm run archive -- import /path/to/raw.json --db result/posts.sqlite
npm run badminton -- prepare --db result/posts.sqlite --model-config /path/to/model.json --out result/handoff-001
```

新觀察或新契約使用新的交接目錄，避免覆寫尚在使用的交接紀錄。prepare 與 accept 都在交接目錄保存 run_report.json；發布報告另位於該發布批次。

prepare 會讀所有最新觀察（不使用 latest CLI 預設的 50 筆上限），保存 `source_records.json`、`task_manifest.json`、`extraction_contract.json` 與 `llm_tasks.jsonl`。只有待處理任務進入 JSONL；成功任務不重跑。交接時把此次 `extraction_contract.json` 的完整規則、schema、範例與每筆 `{id, context}` 一起交給模型，結果保存為 `{id, analysis}` JSONL。

```sh
# 可選：開始交接時記錄處理中；accept 也可直接開始待處理任務
npm run badminton -- etl start --db result/posts.sqlite --run result/handoff-001
npm run badminton -- etl accept --db result/posts.sqlite --run result/handoff-001 --analysis result/handoff-001/llm_results.jsonl
npm run badminton -- etl publish --db result/posts.sqlite --out result/sessions
npm run badminton -- validate --run result/sessions
```

`accept` 逐篇保存驗證結果，壞掉的單行 JSON、未知 ID 和重複 ID 會回報行號／ID；其他合法貼文仍能完成。`accept` 或 `publish` 部分完成時退出碼為 2，致命錯誤為 1，全部完成為 0。檢查 JSON 報告後可以明確執行 publish 發布已成功集合，不要用 shell 的 `&&` 把部分完成當作全部成功。

頁面程式更新後可執行 `etl publish --db result/posts.sqlite --out result/sessions --refresh` 重新產生產物，無須重抽已成功 analysis。

瀏覽 `result/sessions/current/index.html`；頁面可直接以本機檔案開啟，不需伺服器。CLI 回傳的 `page`、`output`、`csv`、`report` 都指向同一不可變發布批次。`current` 原子切換，讀多個產物的程式須先解析一次 `current` 的真實目錄，再讀該目錄；不要在不同時間分別解析根目錄快捷連結。頁面內的 CSV 下載綁定該頁資料快照，重新發布後既有開啟頁面的下載仍屬原批次。

## 靜態網站發布

此節是日常網站更新的操作依據；首次建立 repository 與啟用 Pages 見 [README](../../README.md#github-與靜態網站發布)。以下指令從專案根目錄執行，將資料庫及發布目錄換成此次實際使用的路徑。

### 1. 完成本機發布

先依前述抽取流程完成發布。`etl extract --out` 已發布此次結果時，可直接進入驗證；人工交接或需要獨立發布時執行：

```sh
npm run badminton -- etl publish --db result/facebook-posts.sqlite --out result/sessions
```

若發布範圍限定某個 handoff，加上 `--run <handoff-directory>`，保留原本的資料範圍。只修改頁面程式時，在相同發布命令加上 `--refresh`，重新產生 HTML。`npm run build` 只建置 Chrome 擴充功能，不會更新場次頁面。

### 2. 驗證發布資料

```sh
npm run badminton -- validate --run result/sessions
```

檢查命令退出碼、JSON 摘要及該批 `run_report.json`。修正驗證錯誤後再更新網站；若發布為 partial，需依本次任務範圍確認是否發布已成功集合，並明列未完成部分，不能宣稱全量完成。格式驗證不取代抽取語意確認。

### 3. 更新並檢查網站快照

```sh
npm run site:update -- result/sessions/current
```

此指令解析 `current` 後，把該不可變發布批次的實際 HTML 複製至 `site/index.html`，不重新抽取或產生頁面。驗證到複製期間避免切換同一發布目錄的 `current`；需要固定批次時，兩個指令都改用同一個 `releases/<publication_id>` 目錄。

用瀏覽器開啟 `site/index.html`，確認場次、搜尋、篩選及 CSV 下載符合預期。快照內嵌頁面程式、完整發布資料與 CSV，包含原文、作者及聯絡資訊；選定快照即選定對外發布的資料。只複製此 HTML 即可使用主場次網站；其他三類資料檔不會由 `site:update` 複製。

### 4. 提交並推送

在本次工作已授權 commit／push 的範圍內執行；僅整理本機資料不代表要求上線。

```sh
git add site/index.html
git diff --cached --stat
git commit -m "Update session website"
git push
```

提交前檢查暫存內容，保留無關工作。`result/`、`output/`、SQLite 與抽取中間產物繼續留在本機。若本次也修改網站產生器，將相關原始碼按任務範圍一併提交；只提交原始碼不會重新生成網站快照。

### 5. 確認線上部署

[Pages workflow](../../.github/workflows/pages.yml) 在 `main` 收到 `site/**` 或 workflow 本身的變更時觸發，也可從 Actions 手動執行 **Deploy site to GitHub Pages**。推送其他分支不會觸發這個自動部署流程。

在 Actions 確認對應提交的 workflow 成功，從 `github-pages` environment 開啟網站，確認頁面資料與本次快照一致，再回報線上更新完成。若失敗，查看失敗步驟的記錄；尚未啟用 Pages 時，依 README 完成設定後重新執行。推送成功或本機 HTML 更新都不代表部署成功；無法查看線上狀態時，回報已完成的步驟與尚未驗證的部署狀態。

## 新觀察與版本選擇

重新 import 新 raw、prepare 新交接目錄即可。相同邏輯 JSON（忽略物件鍵順序與排版）不再追加觀察；內容改變仍形成新觀察。最新觀察依合法擷取時間、寫入時間與觀察 ID 選擇；沒有合法擷取時間的觀察不能超越合法時間的觀察。

重用必須同貼文 key、有效 context、規則、schema、模型設定皆相同。新觀察只有互動數改變且 context 相同時，可重用成功 analysis；程式會重新驗證、組裝原文、作者與網址。擷取時間、發布時間／參考來源、截斷標示都是 context 的一部分。指紋識別不保證能串起改文前後版本。

發布只看每個 key 的最新目標；晚完成的舊任務不能蓋掉新成功結果。合格新結果整組取代舊場次，非招生或不足以產生場次的合格結果撤下舊場次。新任務未完成時可暫留上一個已發布成功版本，來源同時保存舊觀察 ID、最新觀察 ID、目標任務及 stale，頁面顯示「來源已有新版，整理尚未更新」。

## 失敗、重試與中斷

```sh
npm run badminton -- etl status --db result/posts.sqlite
npm run badminton -- etl retry --db result/posts.sqlite --failed
# 或只重試指定失敗任務
npm run badminton -- etl retry --db result/posts.sqlite --id post_...
# 程序中斷後明確重排殘留的處理中任務
npm run badminton -- etl recover --db result/posts.sqlite
npm run badminton -- prepare --db result/posts.sqlite --model-config /path/to/model.json --out result/handoff-retry
```

status 與 `extraction_attempts` 保存具體錯誤、原始模型結果、嘗試次數及開始／完成時間。修正時依錯誤欄位重新抽取，不補造證據；accept 不會自動呼叫模型；extract 的有限重試依上方設定執行。相同結果重送成功任務是重入操作，不增加嘗試；不同結果不能覆蓋已成功任務。

成功貼文若需要人工指定重抽，建立新的任務，不覆寫成功分析：

```sh
npm run badminton -- prepare --db result/posts.sqlite --model-config /path/to/model.json --post-key 'url:https://www.facebook.com/groups/.../posts/.../' --rerun --out result/handoff-rerun
```

SQLite 使用 sql.js 快照寫入，因此 archive/ETL 命令對同一資料庫使用程序鎖。中斷若留下 `<db>.lock`，先讀鎖內 PID 並確認該程序已結束，再刪除此鎖、執行 recover；不要移除活躍程序的鎖。發布中斷留下的 release 不是 current，可保留以供追查。若中斷發生在切換 current 後、記錄發布狀態前，下次 publish 會依 current 校正狀態。

## 資料升級與既有 CLI

首次開啟舊庫會以新增欄位升級至 archive schema 2，回填輸入雜湊及合法擷取時間；既有重複觀察、raw 與 observation ID 不清除。首次 ETL 使用時在同一庫建立 `extraction_*` 表，下一次寫入以原子檔案取代保存。保留原資料庫備份即可回查升級前狀態，無須清空重建。

raw 匯出及 archive import/latest/history 入口保持。prepare 的 raw 檔模式，以及獨立 join/finalize/query/validate 仍可使用；raw prepare 可加 `--model-config` 保存實際設定，未提供時明列 manual/unspecified，相容模式不具實際模型識別。持久化流程請用上述 archive 模式。

目前 schema 驗證跨日偏移、列舉 warning 與欄位一致性。新模型輸出不含 evidence；讀取既有含 evidence 的結果仍驗證引用及欄位覆蓋。無法通過的結果會要求重新驗證／抽取，不補造證據。舊版產物目錄沒有 current 發布結構時，finalize 要求新的輸出目錄，保留舊資料。既有 `output/` 個人資料與原型完全保留。

JSON／報告含 `schema_version`、`publication_id`；archive 產物的來源與任務另保存版本關聯。CSV 添加跨日、key、新舊 observation ID、stale、needs_review 欄位；原欄位繼續存在。run_report 的 tasks 計數單位是每個 post_key 的最新目標，stats.listings 才是場次數；published 包含已發布非招生判定，不能當場次總數。

## 頁面與 CLI 查詢

網站操作集中在[使用指南](../user-guide.md)。頁面預設保留已滿、取消，隱藏確定重複；CLI 使用匯出的條件即可匹配相同集合，不要假設 CLI 預設狀態與網站相同。

按「匯出查詢設定」取得 query.json，再對同一發布批次 CSV 執行：

```sh
npm run badminton -- query --csv result/sessions/current/output_result.csv --plan /path/to/query.json --out result/search.csv
```

頁面排序是瀏覽排序，CLI 排序仍依聯絡性與偏好分數；兩者相同條件的 listing ID 集合一致。

## 真實樣本語意驗收

[30 篇候選集](../../skills/badminton-session-finder/tests/fixtures/quality-candidates.json) 取自既有本機真實來源，移除作者 metadata、網址與聯絡識別，保留場館與時段以供配對。`draft_expectation` 為 agent 草稿，不能視為人工標註。逐篇隱私及語意確認後填 `review={reviewer,confirmed_at}`、完整 `acceptable_analyses`（可列數個容許的缺值／歧義答案），並補入確實 content_is_truncated=true 的來源樣本；目前資料沒有該標示。

以同版契約抽取這些去識別化 context，執行：

```sh
npm run badminton -- quality --samples /path/to/reviewed-samples.json --analysis /path/to/sample-results.jsonl --out result/quality-report.json
```

quality 分開檢查格式與人工語意標註，報告日期／時間／場地配對、漏抽、額外場次與各關鍵欄位正確率；未標註、缺結果、格式錯誤或缺案例類別都不能通過。未達 30 篇人工確認或有關鍵欄位不符，退出碼為 2。不得把此報告的 schema 通過解讀成全量資料語意正確。

切換模型續跑時，以新的 handoff 目錄執行 `prepare --preserve-succeeded`。已完成且來源、規則與 schema 未變的任務保留原始模型紀錄，只有未完成的貼文採用新模型；新的 handoff 仍包含完整發布範圍。`batch_size` 可在模型設定指定，CLI `--batch-size` 優先，範圍為 1–100 篇。

## 精簡模型輸出

目前抽取契約以[抽取契約產生器](../../skills/badminton-session-finder/scripts/lib/contract.mjs)及 references 為準。模型只輸出 id 與有用的結構化場次資訊，不產生原文引述 evidence、title、notes 或 confidence；短文字欄位只保留必要條件或報名操作。程度接受小數。原始文字與來源資訊留在本機 archive，透過 id 關聯。

讀取既有含 evidence 的結果時仍檢查其引用與欄位覆蓋；新結果不要求模型重複原文。格式、日期／時長、名額矛盾與聯絡值仍會驗證，但這些檢查不代表所有語意都已人工確認。既有發布格式保留相容欄位，省略的 title/confidence 使用 null，notes/evidence 使用空陣列。

規則及 schema 更動後，舊 handoff 不可直接續跑；使用新的 `prepare --out` 建立符合目前契約的任務。

## 服務分類與玩法

目前抽取支援 session（球友揪團）、venue_rental（場租／轉讓）、coaching（教練課程）、tournament（正式賽事）。不辨識運動項目。沿用 is_recruitment，true 表示包含上述服務；場租亦需保留。分類與對應 service_details 經驗證後，在同一發布流程輸出主場次表與 venue_rentals、coaching_courses、tournaments 三組 JSON／CSV；current 切換前完成全部產物，validate 逐表核對。

主頁增加玩法欄位及單選篩選（七種玩法，單雙打可查旗下所有形式），支援排序、條件標籤、選取預覽及複製。現有來源與已完成抽取不重新分類，發布補 listing_type/play_format/service_details=null，因此新增三表可能為空，舊表中原先混入的課程／場租仍會保留。需要重新分流時另行安排補抽取；不要修改歷史 handoff 的 extraction_contract.json。新 prepare 使用新契約，模型與批次設定沿用既有設定。

舊 v3 發布可用 publish --refresh 更新頁面及新增空欄位：僅限目前已發布且 task ID、來源觀察、context／規則／schema／模型版本、analysis 全部相同的成功任務，通過現行相容驗證後重新發布。未發布的舊任務、內容變更或其他契約升級仍要求 prepare 與重新抽取。原任務與封存契約不修改。


完整分類欄位與輸出檔案規格見[輸出契約](../../skills/badminton-session-finder/references/output-contract.md)。網站操作與複製限制統一記錄在[使用指南](../user-guide.md)。
