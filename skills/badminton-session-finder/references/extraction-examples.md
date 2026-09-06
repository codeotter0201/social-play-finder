# 契約 v4 案例

下列是合成的教學案例，不是人工標註的真實貼文驗收集。各案例輸出仍須填齊 schema；未列出的事實為 null 或空陣列。

| 原文 | 預期拆分與缺值 |
| --- | --- |
| 2026/9/5 14:00–16:00 松林館羽球臨打，每人200元 | 一場 2026-09-05，14:00–16:00，offset=0，場館松林館，200 元；地區與程度未知 |
| 羽球臨打：9/5（六）14:00–16:00 松林館；9/6（日）18:00–20:00 青石館 | 參考時間 2026-09-01 時，恰兩場，日期／時間／場地按分號配對，不能產生四場或交換場館 |
| 羽球每週六 19:00–21:00 松林館，另加開 2026/9/6 10:00–12:00 青石館 | 週期場與明確日期各一場；不能把每週六強換成 9/5 已確認開團 |
| 2026/9/5 23:00 至隔日01:00 松林館羽球臨打 | 一場 offset=1；end_time=01:00，不輸出原文引述 |
| 羽球週六 14:00–16:00 松林館，男300女250；同行兩人每人200 | 一場三個 price_options，condition 各保留男、女、同行兩人每人；最低已列金額200，並非每人無條件200 |
| 羽球臨打 9/5（六）14:00，場地詳… | 截斷 context 下保留 start_time，其餘未出現資料為 null；end_day_offset=null；警告 source_content_truncated、missing_time、missing_venue、missing_price |
| 出售二手羽球拍，今天特價 | 非招生 false 與空 listings |
| 羽球今天 19:00–21:00 松林館，9/5（日） | 無可信發布時間、參考時間2026時，今天不可由擷取日換算；9/5與星期衝突，日期null；relative_date_unanchored、source_conflict、ambiguous_date |

程度 7.5–8.5 應保留小數；多組程度保留場地配對。LINE ID／電話保留原值，操作要求只簡短放 instructions。不輸出 evidence、標題、摘要、notes 或 confidence。


## 分類與玩法案例

下列列出關鍵欄位；實際輸出仍需填齊 schema。既有上表的臨打案例均為 session，未明說玩法時 play_format=null。

| 原文 | 關鍵結果 |
| --- | --- |
| 雙打臨打，男雙女雙混雙都可 | session、doubles、service_details=null |
| 徵混雙，一男一女搭檔 | session、mixed_doubles |
| 限男生參加，玩法未提 | session、play_format=null |
| 單打找球友，不限男女 | session、singles |
| 只徵男單／只徵女單 | 分別 mens_singles／womens_singles |
| 女雙練習；男雙練習 | 分別 womens_doubles／mens_doubles；只有獨立場次才拆列 |
| 單雙打都可以，時間還沒決定 | session、play_format=null、schedule 缺值 |
| 9/8 18–20 點場地轉讓兩面，每面每小時500元，須整段接手 | venue_rental；rental_kind=transfer、court_count=2、billing_unit=每面每小時、transfer_terms=須整段接手；500元方案 duration_minutes=60 |
| 陳教練初學班，每週六10–12點，共8堂4000元，6人班 | coaching；coach_name=陳教練、audience=初學者、lesson_count=8、class_size=6、billing_unit=每人整期；play_format=null；4000元不可除以單堂2小時 |
| 秋季公開賽，10/10開打，9/30截止，男雙組每隊800元 | tournament；event_name=秋季公開賽、divisions=[男雙組]、play_format=mens_doubles、billing_unit=每隊；日期按可信年份規則 |
| 周六雙打臨打200元；另外招生一對一教練課每堂1000元 | 同篇兩筆：session/doubles 與 coaching/null，費用分開；一對一授課不等於單打 |
| 今天大家打比賽很開心 | 無關心得，false、listings=[] |
