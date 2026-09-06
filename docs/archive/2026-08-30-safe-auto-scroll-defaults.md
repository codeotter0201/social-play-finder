# 可調批次目標與低頻自動捲動

> 封存紀錄：僅供追溯當時背景，不代表目前行為。現行入口見[文件索引](../README.md)。

日期：2026-08-30
範圍：擷取入口、篇數目標與頁面互動節奏

## 決定

批次不提供其他擷取方式；使用者開始後一律執行自動捲動。篇數目標預設為五篇，自動捲動時限預設為 30 分鐘，連續無新貼文輪數預設為十輪，三者皆可在開始前調整；低負載互動節奏也可在安全範圍內設定。JSON／CSV 批次契約不包含已無分支語意的擷取方式欄位，並保存本批次實際使用的篇數、時限、停止輪數與 pacing 設定。

所謂基本反爬蟲保護在此專案中定義為低負載保護，而不是規避偵測：卡片之間加入有界等待，捲動間隔使用有界 jitter，連續沒有新貼文時逐步放慢，每次捲動保持在設定的 viewport 百分比內。背景暫停及 Facebook 阻擋訊號停止維持不變。不加入指紋偽裝、驗證碼處理、限流繞過或內部 API。

## 實作邊界

- Popup 提供篇數目標、自動捲動時限、連續無新貼文輪數與可收合的低負載互動進階設定，並在本機保存上次使用值。
- Background 驗證並保存完整 `BatchSettings`；content runner 使用同一份批次快照。
- `src/core/settings.ts` 集中預設值、安全範圍、驗證與輸出轉換；`src/core/pacing.ts` 只依已驗證設定計算節奏。
- 節奏函式可用注入的亂數來源做確定性邊界測試。
- 舊的擷取方式 enum、輸出欄位與專用停止原因已移除。

## 驗證

測試確認預設五篇、30 分鐘與十輪、自訂批次設定、安全範圍、無新內容 backoff，以及 runner 依自訂輪數與時限停止。

```text
npm run check
Test Files  9 passed (9)
Tests       39 passed (39)
Node tests  3 passed (3)
TypeScript typecheck passed
Production build passed

npm audit
found 0 vulnerabilities
```

`dist/` 已由同一次正式 build 重新產生。

## 停止與結果控制修正

實際操作發現兩個生命週期問題：popup 使用原生 `confirm()` 確認捨棄，可能因 popup 失焦而中斷；runner 的停止旗標也不會喚醒卡片或捲動 pacing timer，導致舊執行體在結果已停止後仍短暫存活。

- 捨棄結果改用 popup 內的確認 dialog，並在背景拒絕操作時顯示錯誤。
- 停止會立即封裝並保存當下結果，同時喚醒 pacing timer；停止後不再額外捲動。
- 新增「捨棄結果」及「停止、手動捲動、再次開始」的 DOM／runner 生命週期回歸測試。

修正後驗證：39/39 Vitest、3/3 Node tests、TypeScript typecheck 與 production build 全部通過；`npm audit` 回報 0 vulnerabilities。

## 批次啟動握手修正

加入可調篇數目標時，popup 曾依賴 `PREPARE_START` 回傳完整作用中批次。若 popup 與 background 載入的版本不同，background 可能已建立 preflight 批次，但 popup 因回應沒有 `data` 而中止，留下無 runner 可停止的作用中狀態。

- 批次 ID 改由 popup 產生，並與篇數目標一起單向傳給 background 及 content runner。
- `PREPARE_START` 成功只需回覆 `ok`，popup 不再依賴回傳的批次物件。
- preflight 階段的停止操作直接撤銷 background 暫存，不再傳給尚未建立的 content runner。
- 回歸測試以不含 `data` 的成功回應啟動批次，並驗證 preflight 可被停止及清除。
