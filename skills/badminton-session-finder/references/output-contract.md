# 輸出契約

## 中間產物

- `source_records.json`：完整 batch/post raw objects、scripts 建立的 ID 與 link inventory。
- `llm_tasks.jsonl`：每行只能有 `id`、`context`。
- `llm_results.jsonl`：每行只能有 `id`、`analysis`。
- `joined_records.json`：analysis 依 ID 附加到來源 post；raw 不得被覆寫。

## 最終產物

- `output_result.json`：無損來源、analysis、listings 與統計。
- `output_result.csv`：一列一場次的搜尋檢視。
- `run_report.json`：來源、分析、listing、重複、警告與缺漏統計。

CSV 必須保留：

- 來源：source file、batch/group、post/author ID 與 URL、時間、截斷與 warnings。
- 場次：日期／週期、時間、場館／地址、程度全文、價格方案與顯示文字、狀態與缺額。
- 聯絡：instructions、LINE、電話、registration URLs、post URL、author URL、主要入口與 contactability。
- 品質：confidence、warnings、event group、dedupe、raw text 與 search text。

`price_display` 無金額時固定為「原文未公開，請聯絡確認」。

`contactability`：

- `direct`：有報名 URL、LINE ID 或電話。
- `source`：報名方式是留言／私訊，且有原貼文或作者頁面。
- `partial`：有來源入口，但原文沒有明確報名方式。
- `unavailable`：沒有任何實際入口。

主要聯絡入口依序選擇：報名 URL、LINE ID、電話、原貼文、作者頁面。不得根據 Facebook user ID 合成 Messenger URL。

## v2 的版本、品質與發布

`extraction_contract.json` 封存本次目的／規則、schema、案例與模型設定；archive 模式另以 task_manifest、SQLite 任務和逐次嘗試關聯版本。模型交接頂層仍為 `{id, context}` 與 `{id, analysis}`。

最終 JSON 與報告新增 `schema_version=badminton-output-2`、`publication_id`。schedule 的 `end_day_offset` 為 0／1／null；CSV 添加同名欄位及 post_key、observation_id、latest_observation_id、source_stale、needs_review。來源 raw、analysis 與每個發布來源的觀察／任務關係保留；品質包含固定 warning 代碼及 evidence，個案說明保存於 notes。

finalize 建立完整的不可變 release，包括單一 `index.html`、JSON、CSV 與報告，再切換 current。命令回傳該批次的實際檔案路徑。已存在的非管理產物不覆寫，改用新目錄；[操作指南](../../../docs/development/post-etl-operations.md) 說明重試、恢復、升級與批次讀取方式。

## 分類與玩法擴充

抽取契約為 `badminton-extraction-4`；發布維持 `badminton-output-2` 的相容擴充。新抽取 listing 包含 `listing_type`、`play_format`、`service_details`。舊 analysis 缺少新增欄位仍可讀取，finalize 補 null，不改寫來源 analysis 或回推分類。`is_recruitment` 沿用名稱，新抽取時表示是否包含揪團、場租、課程、賽事任一服務。

`output_result.json.listings` 及 `output_result.csv` 保留 session 與未分類舊資料；CSV 尾端追加 listing_type、play_format。JSON 的 `tables` 保存另外三種集合，每個集合也發布獨立 JSON／CSV：

- `venue_rentals`：出租、轉讓、轉租；rental_kind、billing_unit、transfer_terms。
- `coaching_courses`：coach_name、audience、course_schedule、lesson_count、class_size、billing_unit。
- `tournaments`：event_name、divisions、registration_deadline、event_end_date、billing_unit。

獨立 JSON 保存完整發布 listing（來源、聯絡、品質、原文），CSV 為該類型欄位檢視，含查詢需要的來源連結及去重欄位；三表與主表在同一 release 完成後才切換 current。`validate` 一併核對六個新檔案。stats.listings 仍為主表數量，stats.total_records 為全部類型筆數，stats.tables 為另外三表各自數量。不同類型與已知不同玩法不合併去重；缺少分類與玩法的舊資料沿用既有去重識別。

現有瀏覽器僅顯示主表，玩法中文映射為雙打、男雙、女雙、混雙、單打、男單、女單；未知空白。單選「雙打（全部）」及「單打（全部）」分別包含旗下特定玩法，特定玩法精確比對。CLI 查詢以 play_format 的 in 運算表達同樣群組，eq 表達精確值。其他三表暫無獨立網頁。
