# 2026-09-05 貼文 ETL 與場次瀏覽驗收

> 封存紀錄：僅供追溯當時背景，不代表目前行為。現行入口見[文件索引](../README.md)。

程式增量實作已完成；需求的完整完成定義仍待人工樣本與使用者頁面確認。沿用 archive、prepare、join／validation、finalize、query，必要新增任務協調與單一表格頁面；未引入模型 SDK、框架或替代 ETL。

## 自動檢查

- `npm run check`：TypeScript、50 個擷取／匯出測試、5 個 archive 測試、23 個 badminton 測試與 build。
- `quick_validate.py skills/badminton-session-finder`：skill 結構檢查通過。
- 示範發布批次（歷史產物未隨專案保存：`../../result/post-etl-demo-20260905/published/current/index.html`） 使用三筆合成來源，已經 archive → prepare → JSONL accept → publish → validate；三篇成功、三場、其中一篇缺價需確認。它不是現有個人資料的重新抽取結果。

| 驗收情境 | 程式證據 |
| --- | --- |
| A1–A3 | 反序匯入仍選最新擷取；無效日期時間不擠掉可靠時間；時間相同穩定排序；格式不同的同邏輯 JSON 不追加；指紋／截斷警告；64 個 key 的 prepare 沒有 50 筆展示上限 |
| A4 | context、模型與規則版本改變建立任務；互動資料及被遮罩網址變動在有效 context 相同時重用 analysis，來源與聯絡網址重新組裝 |
| A5 | 亂序按 ID 合併；未知／重複 ID、非法 JSON、未知 warning、捏造 quote、空／錯欄證據、非法日曆與時間、倒置上下界拒絕並定位 |
| A6 | 跨午夜保存 offset；條件價格與缺值保留；語意錯配另有品質 evaluator，真實樣本尚未人工驗收 |
| A7 | 模擬處理中中斷、個別失敗、明確 recover/retry；成功任務不重跑、不被修改；部分完成持久保存於報告 |
| A8–A9 | 三場→一場→非招生撤下；失敗保留舊場次並標示 stale、新舊觀察 ID；舊任務晚完成不覆蓋最新結果 |
| A10 | 在全部產物寫好、切換 current 前注入中斷，上一批 JSON／CSV／報告／頁面逐位元不變；驗證器拒絕跨產物內容、ID 或批次漂移 |
| A11–A12 | 頁面與 CLI 七組條件得到相同 ID 集合；清除、OR／AND、零結果、免費與缺價、新手程度未知、預設狀態／去重、空值排序及原文 HTML 不執行 |
| A13 | 建立舊 schema SQLite 後升級，保留 raw、舊重複與 observation ID；舊結果明確要求重驗／重抽；獨立 CLI 流程仍通過 |

## 真實瀏覽器證據

Chrome DevTools 在獨立測試 profile 驗證 1440px 桌面及 390px 手機視窗：完整 3 場，價格上限 0 得到 0 場，清除後恢復 3 場，原文詳情可展開，無載入錯誤；兩種寬度的 document scrollWidth 都等於 viewport 寬度。

- 桌面截圖（歷史產物未隨專案保存：`../../result/post-etl-demo-20260905/desktop.png`）
- 手機截圖（歷史產物未隨專案保存：`../../result/post-etl-demo-20260905/mobile.png`）
- Chrome 互動測量（歷史產物未隨專案保存：`../../result/post-etl-demo-20260905/browser-smoke.json`）

最初以 Chrome 命令列 dump-dom／screenshot 啟動時曾在輸出後關閉逾時；改以 DevTools 驗證並明確關閉獨立程序後完成。這是 agent 的瀏覽器實測與畫面檢查，尚未取代使用者的實際裝置確認。

## 人工語意驗收尚未通過

[30 篇真實來源候選集](../../skills/badminton-session-finder/tests/fixtures/quality-candidates.json) 已移除作者 metadata、網址與已辨識的聯絡／個人 token，保留場館與時段並附 agent 標註草稿。所有 `review` 為 null、`acceptable_analyses` 為空，避免把 agent 草稿稱作人工標註；仍需人工確認去識別與語意。

品質報告（歷史產物未隨專案保存：`../../result/post-etl-demo-20260905/quality-report.json`） 實際結果：sample_count=30、human_reviewed=0、passed=false，各欄位準確率為 null，退出碼 2。此次沒有模型的真實樣本結果，不能宣稱無捏造、無錯配或全量資料正確。

既有 800 篇 raw 沒有 `content_is_truncated=true` 的來源；候選集包含末段不完整的文字，仍保留原始 false 旗標，不能代替真實截斷案例。需再補入合法截斷來源及人工標註，並以同版契約抽取後執行 quality，報告漏抽與各欄位準確率。來源衝突、男女程度差異、組合時數與額外入場費的可接受表示也需人工確認。

## 操作與限制

完整命令、升級、過程鎖與中斷恢復見[操作指南](../development/post-etl-operations.md)。新發布使用新的 result 目錄；既有 output 個人資料與原型未覆寫。模型結果仍由人工交接；未新增外部上傳或自動分析。

資料庫使用原有 sql.js，archive/ETL CLI 對同一庫序列執行。程式讀多個發布產物時必須先解析一次 current 到不可變目錄；頁面內下載 CSV 已綁定該頁快照。仍待完成的需求項目是人工標註／模型品質驗收，以及使用者實際頁面確認。
