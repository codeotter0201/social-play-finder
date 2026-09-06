# social-play-finder 文件索引

現行文件直接更新，不為每次改版另建副本。過時的計畫、修正與驗收紀錄集中在封存區，不作為操作依據。

## 依讀者選擇

| 讀者 | 入口 |
| --- | --- |
| 網站使用者 | [網站使用指南](user-guide.md)：搜尋、排序、比較、複製及資訊解讀 |
| 操作人員 | [貼文整理操作指南](development/post-etl-operations.md)：載入擴充功能、擷取、匯入、抽取、發布、恢復與品質檢查 |
| 開發者 | [專案首頁的開發說明](../README.md#開發)：環境、程式位置與測試指令 |
| AI Agent | [專案規範](../AGENTS.md)、[抽取 skill](../skills/badminton-session-finder/SKILL.md) |

## 規格與決策

- [擴充功能需求](requirements/facebook-group-post-exporter.md)：頁面擷取、匯出、停止條件與 live smoke test。
- [貼文整理與場次瀏覽需求](requirements/post-etl-and-session-browser.md)：來源關聯、抽取、服務分流、發布與網站功能。
- [抽取與輸出契約](../skills/badminton-session-finder/references/output-contract.md)：資料檔案、分類結構、相容性與發布規則。
- [頁面資料來源](adr/0001-use-rendered-page-data-only.md)、[擴充功能權限](adr/0002-minimize-extension-permissions-and-network-access.md)、[原始匯出格式](adr/0003-export-batch-json-and-safe-flat-csv.md)、[SQLite 歷史庫](adr/0004-archive-exports-in-local-sqlite.md)：仍有效的架構決策。

## 封存

[封存索引](archive/README.md)只供追溯當時的計畫及驗收背景。現行說明與封存紀錄有差異時，以現行規格、操作指南及程式為準。
