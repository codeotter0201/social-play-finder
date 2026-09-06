# 搜尋模式

## 目的

把使用者目的轉成結構化查詢計畫，交給 `query` script 確定性篩選、分組與排序。不要直接閱讀數百列後憑印象挑選。

## 流程

1. 讀取 CSV header，確認必要欄位存在。
2. 依 [query.schema.json](query.schema.json) 寫出 query JSON。
3. 執行 `npm run badminton -- query`。
4. 讀取產生的 search result JSON，依 [result-format.md](result-format.md) 回答。

## 預設語意

- 「18:00 以前」是 `start_time <= 18:00`，包含 18:00。
- 「18:00 前結束」是 `end_time <= 18:00`。
- 「9/2 或週三，18:00 前」是 `(date=9/2 OR recurrence_weekdays contains 3) AND start_time<=18:00`。
- 「週三」可匹配明確日期為週三或固定週期包含週三；回答中要區分本次日期與固定團。

若語句的 AND／OR 範圍會造成明顯不同結果，先用一句話說明預計解讀；只有無法合理預設時才詢問。

## 篩選與偏好

硬條件放在 `where`：日期、星期、時間、地點、狀態、明確預算上限、指定聯絡管道。未知值不算符合硬條件。

偏好放在 `preferences`：新手友善、希望價格、需要可聯絡。排序優先：

1. `contactability=direct`
2. `contactability=source`
3. 程度符合
4. 價格已知且符合
5. open 狀態、完整欄位與較高 confidence

預設排除 duplicate、full 與 cancelled。possible duplicate 依 `event_group_id` 聚成同場 variants，不靜默刪除。

玩法查詢使用 play_format：雙打全部為 in ["doubles","mens_doubles","womens_doubles","mixed_doubles"]，單打全部為 in ["singles","mens_singles","womens_singles"]；特定玩法用 eq，缺值不匹配。未要求玩法時不增加此條件。其他服務可將 query --csv 指向 venue_rentals.csv、coaching_courses.csv 或 tournaments.csv；目前查詢 schema 僅提供共用欄位篩選，專屬欄位保留於輸出。
