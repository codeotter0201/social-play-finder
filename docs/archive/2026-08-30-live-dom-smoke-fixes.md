# 真實 Facebook DOM smoke 修正

> 封存紀錄：僅供追溯當時背景，不代表目前行為。現行入口見[文件索引](../README.md)。

日期：2026-08-30
範圍：MVP 第一輪實際社團動態牆驗證與 code review 後修正

## 背景

初版的 18 項去識別化 fixture 測試、typecheck 與正式 build 均通過，但實際頁面匯出結果顯示本文皆為空字串、作者缺失，且多數所謂貼文網址帶有 `comment_id`。Popup 的單篇預覽也會在展開後約 750 ms 自動收合。

後續檢視實際呈現 DOM，確認目前 Facebook 結構與初版 fixture 有關鍵差異：主貼文外層不是 `role="article"`；留言才使用該 role，而主貼文本文使用 `data-ad-rendering-role="story_message"`，長文展開控制則顯示「顯示更多」。實際 DOM 中的姓名、社團識別、貼文內容及 CDN 網址未寫入 repository；回歸測試只保留去識別化的最小結構。

## 問題、根因與處理

| 問題 | 根因 | 處理 |
| --- | --- | --- |
| 本文皆為空 | 只支援舊的 `data-ad-comet-preview="message"` selector | 新增 `story_message` 與 `data-ad-preview="message"` 語意 selector |
| 把留言當成主貼文 | 主貼文 selector 依賴 `role="article"`，而實際留言使用此 role | 從 `story_message`／`profile_name` 向上解析最近的 `data-virtualized` 主貼文邊界，並排除 `[data-commentid]` |
| 長文沒有展開 | 繁中訊號缺少「顯示更多」，且展開後只固定等待 80 ms | 支援「顯示更多／查看更多／See more」，監聽 DOM 變化最多 1.5 秒；只有本文確實變更且按鈕消失才標示完整 |
| 貼文 ID／網址缺失 | 實際時間連結未必直接包含 `/posts/<id>` | 在可靠附件網址的 `set=pcb.<id>` 中取得 ID，並以批次社團來源建立正規貼文網址 |
| 附件未被擷取 | 初版附件範圍侷限在本文父層，而實際附件是本文的兄弟節點 | 在已辨識主貼文邊界內掃描附件，排除作者頭像、留言區與 Facebook 介面連結 |
| Popup 預覽自動收合 | 750 ms 狀態 polling 每次以 `replaceChildren` 重建 `<details>` | 重繪前以貼文識別保存並恢復 `open` 狀態，同時補上模式與原貼文連結 |
| 一般本文被誤判為排除類型 | 對整張卡片文字搜尋「活動／Poll」等短字串 | 將類型訊號限制在卡片標籤、heading 與 aria label |
| 重複觀察覆蓋可靠欄位 | 合併時以所有後續非 null 值覆寫舊值 | 一般欄位只補 null，互動數量才採最後可靠觀察；ID 與 URL 分別命中兩筆時合併索引 |
| SPA 導航可能混入另一來源 | 只監聽 `pagehide`，Facebook 站內導航不一定觸發 | Content runner 監控社團來源與子路徑，background 監聽分頁 loading；狀態異動序列化並核對 batch ID |

## 回歸證據

新增的最小 fixture 覆蓋實際 DOM 的必要形狀：

- `data-virtualized` 主貼文包含 `profile_name`、`story_message`、附件與巢狀留言 article。
- 「顯示更多」點擊後替換本文 DOM。
- 留言 permalink 帶有 `comment_id`。
- 附件網址以 `set=pcb.<post_id>` 提供貼文識別。
- Popup 在重複 polling render 後保留展開狀態。

最終驗證：

```text
npm run check
Test Files  5 passed (5)
Tests       24 passed (24)
TypeScript typecheck passed
Production build passed

npm audit
found 0 vulnerabilities
```

`dist/` 已由同一次正式 build 重新產生。

## 尚未完成

這輪只驗證並修正一種實際繁中社團動態牆結構，不能代表需求 16.2 的完整 live smoke test 已通過。發佈前仍須驗證公開及私人測試社團、無權頁面、自動捲動停止條件、背景暫停與恢復、各種生命週期停止，以及 JSON／CSV 下載錯誤。Facebook 若再次調整語意屬性或主貼文邊界，應以新的去識別化最小 fixture 更新集中管理的 selectors/signals。
