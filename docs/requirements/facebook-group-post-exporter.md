# Facebook 社團貼文擷取器需求

## 1. 產品目標

本產品是 Chrome 擴充功能，協助已登入 Facebook 的個人研究者，從自己有權瀏覽的單一 Facebook 社團主要動態牆擷取主貼文，供試算表中的人工篩選與整理使用。

成功代表使用者不需逐篇複製貼上，且輸出資料能追溯至 Facebook 原貼文。擴充功能負責擷取與匯出；後續 AI 抽取與歷史庫由[貼文整理流程](post-etl-and-session-browser.md)負責。

共同語言以專案根目錄的 CONTEXT.md 為準。

## 2. 核心原則

- 使用目前分頁既有的 Facebook 登入狀態。
- 不建立獨立登入流程，不讀取或保存帳號密碼、Cookie 或權杖。
- 只讀取使用者目前有權查看、且已呈現在 DOM 或可存取性資訊中的內容。
- 由使用者主動開始；不排程、不跨社團並行。來源分頁在背景時採最佳努力繼續，若瀏覽器或 Facebook 使頁面無法前進則保留批次等待回到前景。
- 資料只在本機處理，MVP 沒有自有後端、產品遙測或自動錯誤上傳。
- 不宣稱能取得社團全部歷史貼文。
- 缺值維持 null；無法可靠解析時不得猜測。
- JSON 是標準、無損輸出；CSV 是試算表安全的便利格式。

## 3. 支援範圍

### 3.1 瀏覽器與頁面

MVP 只支援 Chrome 中的：

    https://www.facebook.com/groups/*

實際可擷取頁面只包含社團主要動態牆，以及 Facebook 在該動態牆提供的排序方式。

以下頁面不受支援：

- m.facebook.com、mbasic.facebook.com、web.facebook.com。
- Facebook App 內嵌頁面。
- 非 groups 路徑。
- 單篇貼文永久連結頁。
- 社團搜尋、媒體、成員、活動、檔案與管理等子頁面。

正式支援的 Facebook 介面語言為繁體中文與英文。其他語言只能盡力解析，不列入 MVP 驗收保證。

### 3.2 可擷取內容

納入：

- 一般主貼文。
- 匿名主貼文。
- 被置頂的一般或匿名主貼文。
- 主貼文內容區中的圖片、一般影片與外部連結預覽之可取得網址。
- 主貼文上可可靠取得的表情、留言與分享顯示數量。

排除：

- 留言本文、留言者、回覆與留言附件。
- 分享貼文。
- 活動、投票與 Reels。
- 廣告、贊助內容、推薦與系統卡片。
- 圖片或影片原始檔案及高畫質來源。

## 4. 開始前驗證

開始批次前必須依序確認：

1. 目前網域與路徑屬於支援範圍。
2. 頁面為社團主要動態牆。
3. 批次來源至少能由社團 ID 或正規社團網址可靠識別。
4. 頁面已完成必要載入。
5. 頁面沒有明確的未登入或無權查看證據。
6. 能辨識必要的社團與貼文結構，或能明確判定目前沒有貼文。

只有頁面明確呈現 Facebook 登入表單或登入提示時，才能回報「尚未登入」。只有頁面明確呈現內容不可用、私人社團不可見或權限拒絕時，才能回報「無權查看」。

若既沒有上述證據，又無法辨識必要結構，應回報「無法辨識頁面／Facebook 頁面結構可能已變更」，不得猜測成登入或權限問題。

頁面有效但找不到可擷取主貼文時：

- 不自動產生空 JSON 或 CSV。
- 顯示「找不到支援的主貼文」。
- 顯示已辨識後排除的卡片數量。
- 不將此情況誤報為 DOM 結構失效。

## 5. 擷取方式與安全上限

- 所有批次固定使用自動捲動，不提供其他擷取方式。
- 以受控間隔向下捲動並持續發現新貼文卡片；來源分頁不在前景時不主動暫停同一批次。
- 捲動不依賴背景頁可能無法完成的平滑動畫；每輪以捲動位置、頁面高度與 feed DOM 更新共同判斷頁面是否前進。
- 卡片處理與捲動採使用者在安全範圍內設定、且不完全固定的低頻等待；連續未發現新內容時逐步增加等待。
- 此節奏只用來降低頁面負載，不宣稱或嘗試規避 Facebook 偵測、限流、驗證碼或存取控制。
- 瀏覽器可能降低背景分頁的計時器頻率；產品不保證背景與前景具有相同擷取速度。
- 使用者可設定自動捲動時限，預設為 30 分鐘且可選範圍為 1 至 1440 分鐘。
- 使用者可設定連續無新貼文輪數，預設為十輪且可選範圍為 1 至 100；達到該輪數時正常完成。
- 背景頁每輪至少等待使用者設定的捲動間隔；若 feed 尚未更新，單輪觀察時間最多延長至三秒。捲動位置、頁面高度或 DOM 任一項前進時不得增加無新貼文次數；背景頁完全無法前進時保留批次等待前景恢復。
- 活動、投票、Reels 與分享等排除卡片仍代表動態牆有前進，會重設「無新貼文」次數。
- 廣告、推薦、系統卡片與重複貼文不會重設該次數。
- 介面顯示「未發現新貼文 n/設定輪數」；背景頁無法前進時顯示等待回到來源分頁。
- 使用者在開始前選擇批次篇數目標；預設為五篇，必須是 1 以上的整數。
- 排除、重複與解析失敗都不占篇數目標。
- 達到使用者選擇的篇數目標時以 completed / target_reached 結束。
- 卡片間隔、捲動等待、無新內容 backoff 與捲動距離可在介面調整；設定必須符合安全範圍，且最小值不得大於最大值。
- 預設卡片間隔為 100–250 ms、捲動等待為 500–900 ms、每輪 backoff 為 300 ms、最大額外等待為 1,500 ms，捲動距離為 viewport 的 70–95%。
- 卡片間隔為 100–60,000 ms；捲動等待為 500–120,000 ms。
- 每輪 backoff 為 0–60,000 ms，最大額外等待為 0–300,000 ms，且每輪值不得大於最大值。
- 捲動距離的最小與最大值都必須在 viewport 的 10%–100% 之間。
- 使用者偏好保存在本機；批次開始後使用當時的設定快照，不受後續偏好變更影響。

## 6. 批次生命週期

- 整個擴充功能同時最多只有一個作用中批次。
- 同一分頁不得重複啟動工作。
- 在另一分頁嘗試開始時，介面應指出現有批次及其社團，並提供前往來源分頁或先停止的操作。
- 關閉 popup 不會停止批次；重新開啟時必須接回狀態與停止控制。
- 導航離開原社團、重新載入或關閉來源分頁時安全停止。
- 關閉整個瀏覽器、停用或移除擴充功能後，不保證保留資料或恢復工作。
- 作用中、完成與部分結果只保存在瀏覽器工作階段暫存中。
- 開始新批次前，若有未處理結果，必須要求使用者先匯出、捨棄或明確允許取代；不得靜默覆蓋。
- 下載完成後不自動刪除暫存結果。

## 7. 狀態與停止原因

批次結果狀態與停止原因必須分開。

| status | stop_reason | 語意 |
| --- | --- | --- |
| completed | target_reached | 達到使用者選擇的批次篇數目標 |
| completed | no_new_posts | 達到使用者設定的連續無新貼文輪數 |
| stopped | user_stopped | 使用者主動停止 |
| stopped | time_limit_reached | 自動捲動達到使用者設定的時限 |
| stopped | page_navigated | 來源頁面導航或重新載入 |
| stopped | source_tab_closed | 來源分頁關閉 |
| failed | access_denied | 批次中失去瀏覽權限 |
| failed | facebook_blocked | Facebook 顯示阻擋或限制 |
| failed | dom_changed | 必要頁面結構失效 |
| failed | fatal_error | 其他不可恢復錯誤 |

stopped 以及已有有效資料的 failed 批次可匯出部分結果，但預覽與輸出必須保留非正常完成的 status 與 stop_reason。

開始批次前發現頁面不支援、尚未登入或無權查看，屬於 preflight 錯誤，不建立看似成功的批次。

## 8. 卡片分類與解析

### 8.1 分類結果

每次真正進入分類或解析流程的卡片觀察，必須且只能落入：

- exported：成功輸出的唯一主貼文。
- excluded：明確屬於不支援類型。
- duplicates：新觀察到、但屬於批次既有貼文。
- failed：既非明確排除，也無法跨過最低資料門檻。

批次統計必須滿足：

    scanned = exported + excluded + duplicates + failed

    exported = posts.length

同一個仍留在 DOM 的節點被週期性看見時，不得重複增加 scanned。

### 8.2 內容

- content_text 只包含作者撰寫的本文，不包含作者、時間、互動摘要、附件預覽文字或介面標籤。
- 保留有意義的換行，清除多餘空白。
- 擴充功能可點擊已辨識主貼文內容區內的「查看更多」。
- 不得點擊留言、附件、外部連結、作者或導覽元素。
- 展開失敗時保留目前可見文字，並設定 content_is_truncated 為 true。
- 成功確認完整時為 false；無法判定時為 null。
- 圖片或影片貼文即使 content_text 為空字串，只要具有可靠貼文識別，仍可輸出。

### 8.3 作者

- 找到具名作者時保留顯示名稱與可取得的正規作者網址。
- Facebook 明確標示匿名時，author_name 保留頁面匿名標籤、author_url 為 null、is_anonymous 為 true。
- 明確具名為 false，無法可靠判定為 null。
- 不得嘗試推測匿名貼文的真實作者。
- 作者解析失敗不得冒充匿名狀態。

### 8.4 時間

- published_time_raw 永遠優先保留 Facebook 顯示文字。
- 只有 DOM 提供明確、可機器判讀的絕對時間時，才輸出 ISO 8601 published_at。
- 不從「3 小時前」、「昨天」等相對文字反推精確時間。
- 缺少年份、時區或日期資訊時 published_at 為 null。
- scraped_at 表示該筆資料的擷取觀察時間，不得作為發布時間證據。

### 8.5 互動數量

- 三種數量都保存 raw 與正規化 number。
- 明確整數優先於縮寫顯示。
- 可依正式支援語系可靠解析「1.2 萬」或「3K」時，正規化為畫面等值。
- 正規化值不宣稱是 Facebook 內部精確統計。
- 無法可靠解析時保留 raw，number 為 null。
- 不為取得精確統計而使用 Facebook 內部 API。

### 8.6 附件

- 只收錄主貼文內容區內實際可見的圖片、一般影片與外部連結預覽。
- 排除頭像、表情符號、留言媒體、Facebook 圖示、導覽連結與其他頁面卡片。
- 不下載檔案、不尋找高畫質來源，也不保證 Facebook CDN URL 長期有效。
- 同一貼文內相同 type 與 url 只輸出一次。
- 能辨識附件但無法取得類型或網址時，保留 type 為 unknown、url 為 null。

### 8.7 URL

- post_url、group_url、author_url 與附件網址在不發出額外請求的前提下正規化。
- 轉成絕對 HTTPS URL。
- Facebook 自家網址統一為 www.facebook.com。
- 移除 fbclid 等明確、且不影響資源定位的 Facebook 追蹤資訊。
- 可從 l.facebook.com 查詢參數解出目標網址，但不得實際連線追蹤重新導向。
- 不任意移除外部網站自己的 query。
- 無法安全正規化時保留可用原網址；不合法時為 null。

## 9. 識別、最低門檻與去重

去重優先順序：

1. post_id。
2. 正規 post_url。
3. 批次指紋。

批次指紋只在 post_id 與 post_url 都缺少時使用，由正規化作者、原始顯示時間與內容組成；不得輸出成 Facebook post_id，也不保證跨批次穩定。

當 post_id 與 post_url 都缺少時，必須同時符合以下門檻才輸出：

- content_text 非空。
- author_name 或 published_time_raw 至少有一項。

去重合併規則：

- 相同 post_id 或正規 post_url 只輸出一筆，並增加 duplicates。
- 後一次可靠的非 null 值可補前一次 null。
- 完整內容可取代截斷內容。
- 互動數量採批次內最後一次可靠觀察值，並更新 scraped_at。
- 後一次 null 不得覆蓋既有值。
- 只靠批次指紋判定時，保留首次結果且不合併後續欄位，避免指紋碰撞。

## 10. 標準資料契約

JSON 標準結構：

    {
      "batch": {
        "batch_id": "uuid",
        "source": "facebook_group",
        "status": "completed|stopped|failed",
        "stop_reason": "string",
        "group_id": "string|null",
        "group_name": "string|null",
        "group_url": "string",
        "target_post_count": "positive integer",
        "no_new_scan_limit": "integer 1..100",
        "pacing": {
          "card_delay_min_ms": "integer",
          "card_delay_max_ms": "integer",
          "scroll_delay_min_ms": "integer",
          "scroll_delay_max_ms": "integer",
          "no_new_backoff_step_ms": "integer",
          "no_new_backoff_max_ms": "integer",
          "scroll_distance_min_percent": "integer",
          "scroll_distance_max_percent": "integer"
        },
        "max_duration_seconds": "positive integer seconds",
        "started_at": "ISO-8601 string",
        "finished_at": "ISO-8601 string",
        "stats": {
          "scanned": "number",
          "exported": "number",
          "excluded": "number",
          "duplicates": "number",
          "failed": "number",
          "failed_by_reason": {
            "unknown_card": "number",
            "minimum_data": "number",
            "exception": "number"
          }
        }
      },
      "posts": [
        {
          "post_id": "string|null",
          "post_url": "string|null",
          "author_name": "string|null",
          "author_url": "string|null",
          "is_anonymous": "boolean|null",
          "content_text": "string",
          "content_is_truncated": "boolean|null",
          "published_time_raw": "string|null",
          "published_at": "ISO-8601 string|null",
          "reaction_count_raw": "string|null",
          "reaction_count": "number|null",
          "comment_count_raw": "string|null",
          "comment_count": "number|null",
          "share_count_raw": "string|null",
          "share_count": "number|null",
          "media": [
            {
              "type": "image|video|link|unknown",
              "url": "string|null"
            }
          ],
          "is_pinned": "boolean|null",
          "scraped_at": "ISO-8601 string",
          "warnings": ["string"]
        }
      ]
    }

批次封裝保存固定自動捲動、批次互動設定與卡片失敗原因，使解析失敗不再只有無法追查的總數。`failed_by_reason` 三項加總必須等於 `failed`。

通用規則：

- 找不到的可選值使用 null，不使用「未知作者」等展示文字。
- boolean 只有在能可靠判定時才為 true 或 false，否則為 null。
- 不因單一欄位缺失而丟棄整篇貼文。
- 每篇 warnings 使用穩定英文代碼；介面負責翻譯。
- warnings 為空陣列只表示沒有已知警告，不表示所有可選欄位都存在。
- 警告不得包含原始 DOM、例外堆疊或額外貼文內容。

初始品質警告至少包含：

- missing_post_identity
- content_truncated
- published_time_not_normalized
- reaction_count_not_normalized
- comment_count_not_normalized
- share_count_not_normalized

## 11. 匯出

### 11.1 JSON

- 使用第 10 節批次封裝格式。
- 保留完整巢狀 media 與 warnings。
- JSON 是原始文字語意的標準輸出。

### 11.2 CSV

- 每列一篇貼文。
- 使用 UTF-8 BOM。
- 逗號、雙引號與換行依 RFC 4180 跳脫。
- media 與 warnings 以 JSON 字串放入單一欄。
- 每列包含社團來源與全部貼文欄位。
- 每列重複且保持一致的批次欄位：

    batch_id
    batch_source
    batch_status
    batch_stop_reason
    batch_started_at
    batch_finished_at
    batch_target_post_count
    batch_no_new_scan_limit
    batch_card_delay_min_ms
    batch_card_delay_max_ms
    batch_scroll_delay_min_ms
    batch_scroll_delay_max_ms
    batch_no_new_backoff_step_ms
    batch_no_new_backoff_max_ms
    batch_scroll_distance_min_percent
    batch_scroll_distance_max_percent
    batch_max_duration_seconds
    batch_scanned
    batch_exported
    batch_excluded
    batch_duplicates
    batch_failed
    batch_failed_unknown_card
    batch_failed_minimum_data
    batch_failed_exception

- 對第一個非空白字元為等號、加號、減號或 at 符號的文字儲存格加上單引號安全前綴，避免試算表公式注入。
- 數字與 ISO 時間欄位不加公式安全前綴。
- 因安全前綴造成的文字差異，以 JSON 為準。

### 11.3 檔名

JSON 與 CSV 使用相同 stem：

    facebook-group_<社團名稱>_<社團ID或網址別名>_<YYYY-MM-DD_HHmmss>_<batch-id前8碼>

- 檔名包含安全化社團名稱及社團 ID（無 ID 時用網址別名）；名稱無法可靠取得時省略，不以通知／聊天室等介面標題代替。
- 時間使用 `batch.started_at` 的瀏覽器本地時間。
- 移除不安全檔名字元；社團名稱與 ID／別名各最多 60 字元。
- 中文社團名稱可保留，不強制轉拼音。
- 兩種格式只在副檔名不同。

## 12. 預覽與介面

預覽是只讀檢視：

- 顯示批次狀態、停止原因、社團來源與統計。
- 顯示前若干筆資料，並可展開單篇欄位及品質警告。
- 提供可用的「開啟原貼文」連結。
- 不提供修改作者、內容、數量或刪除單篇貼文。
- JSON 與 CSV 必須由同一份未修改的批次資料產生。

介面至少顯示：

- 等待開始。
- 正在掃描。
- 正在捲動。
- 來源分頁在背景時仍維持同一批次。
- 背景分頁無法前進時等待回到來源分頁，且不將等待誤判為沒有新貼文。
- 掃描卡片數、成功篇數、排除數、重複數、解析失敗數及各失敗原因。
- 未發現新貼文 n/設定輪數。
- 篇數目標、自動捲動時限、連續無新貼文輪數，以及可收合的低負載互動進階設定。
- 恢復預設設定。
- 使用者已停止、已完成、時限到達。
- 頁面不受支援、尚未登入、無權查看。
- 找不到支援的主貼文。
- Facebook 頁面結構可能已變更。
- Facebook 阻擋或限制。
- 下載失敗。

自動捲動期間必須透過擴充功能徽章或頁面內最小提示，讓使用者知道工作仍在進行或已暫停。

## 13. 隱私、安全與權限

### 13.1 本機資料

- 不上傳貼文、錯誤、使用統計、裝置識別、崩潰或效能資料。
- 不使用分析 SDK、遠端設定、遠端程式碼或自有後端。
- 擴充功能自身不發出產品網路請求。
- 使用者主動問題回報時，只提供不含貼文內容的診斷摘要，且不自動上傳。
- Chrome Web Store 與瀏覽器本身的安裝、更新流量不屬於擴充功能控制範圍。

### 13.2 資料來源

- 擴充功能只讀頁面呈現資料。
- 自動捲動與「查看更多」可觸發 Facebook 正常頁面請求。
- 不攔截、讀取或重放 Fetch、XHR 或 GraphQL 回應。
- 不注入程式攔截 Facebook 網路函式。
- 不直接組裝 Facebook API 請求。
- 不從 Cookie、權杖或隱藏網路資料補欄位。

### 13.3 Chrome 權限

允許的 MVP 權限基線：

- activeTab
- scripting
- storage
- downloads

禁止：

- cookies
- webRequest
- debugger
- history
- all_urls
- 可長期存取所有 Facebook 頁面的廣泛 host permission

若某項允許權限實作後證明不必要，必須移除。若需新增權限，必須先修改需求並記錄理由。

storage 中的貼文資料只可使用工作階段暫存；首次責任確認狀態可以持久保存。

### 13.4 使用責任提醒

- 第一次開始擷取前，阻擋式提示使用者只處理自己有權查看的內容，並遵守 Facebook 條款、社團規則與適用隱私法規。
- 首次確認後不在每批重複阻擋，但 popup 持續提供可查看說明。
- 不宣稱擴充功能已替使用者判定某次擷取是否合法。
- 不嘗試繞過登入、權限、驗證碼、限流或帳號限制。

## 14. 穩定性與失敗隔離

- 單篇解析失敗不得中止整個批次。
- 卡片處理與捲動必須遵守低頻節奏；連續無新內容時增加等待，且不得以節奏隨機化宣稱隱身或規避偵測。
- 選擇器、語系規則與頁面訊號必須集中管理。
- 類型無法安全分類時列為 failed，不得猜測成支援貼文。
- 批次切換頁面或關閉來源分頁時安全停止。
- 使用者停止應在目前不可中斷的小操作完成後盡快生效。
- DOM 結構失效必須以可理解訊息回報，不得輸出看似成功的空檔。
- 部分結果的匯出必須保留失敗或中止上下文。

## 15. MVP 不包含

- 自動登入 Facebook。
- 擷取使用者無權查看的私人社團。
- 繞過驗證碼、限流、帳號限制或存取控制。
- Facebook 內部 API、GraphQL、Cookie 或權杖逆向。
- 分享貼文、活動、投票與 Reels。
- 留言本文、留言者與回覆。
- 下載圖片或影片原始檔。
- 跨多個社團並行或排程。
- 不指定篇數目標的批次。
- 永不停止的自動捲動。
- 雲端同步、遠端資料庫、產品遙測或永久本機歷史。
- 資料編輯器。
- 保證取得社團全部歷史貼文。
- CRM 或 AI 分析流程。

## 16. 驗收證據

### 16.1 自動化 fixtures

使用去識別化的繁中與英文 DOM fixtures 驗證：

- 一般、匿名、置頂與媒體貼文。
- 長文展開成功與失敗。
- 缺少作者、時間、識別與互動欄位。
- 活動、投票、Reels、分享、廣告與系統卡片排除。
- ID、URL 與批次指紋去重，以及有限度合併。
- 網址、時間與互動數量正規化。
- JSON schema、狀態與統計不變式。
- CSV BOM、逗號、雙引號、換行、陣列 JSON 字串與公式注入防護。
- 繁中與英文頁面訊號及錯誤分類。

fixtures 必須去識別化，不得包含真實帳號、Cookie、權杖或敏感社團內容。

### 16.2 Live smoke test

上線前以測試者自行控制、沒有真實敏感資料的社團驗證：

- 可查看的公開與私人測試社團。
- 明確無權查看的頁面。
- 預設五篇及自訂篇數目標、預設十輪及自訂無新貼文輪數、低負載互動設定與自動捲動。
- 開始、停止、預設及自訂時限與部分結果。
- popup 關閉後接回。
- 來源分頁切到背景後仍是同一批次；背景仍有頁面進度時繼續擷取，沒有進度時等待，回到前景後從原批次繼續。
- 導航、重新載入與來源分頁關閉。
- JSON 與 CSV 下載及下載錯誤。
- 擴充功能沒有產品網路請求。

測試帳號、Cookie、權杖與測試社團內容不得存入 repository 或 CI。

### 16.3 MVP 驗收條件

MVP 必須同時滿足：

1. 正確辨識支援的社團主要動態牆。
2. 所有新批次固定使用自動捲動，篇數目標預設為五篇且可由使用者在開始前調整。
3. 能以使用者在安全範圍內選擇、且無新內容時放慢的低負載節奏執行並停止自動捲動。
4. 只輸出一般、匿名及置頂的一般／匿名主貼文。
5. 缺少部分欄位時仍依最低資料門檻輸出。
6. 同一批次不重複輸出相同貼文。
7. JSON 符合批次封裝資料契約，並保存本批次的停止輪數、pacing 設定與卡片失敗原因。
8. CSV 可正確處理中文、逗號、雙引號、換行與公式注入。
9. 未登入、無權限、不支援、零結果與 DOM 失效有不同且正確的提示。
10. popup、分頁可見性與來源頁面生命週期符合本文件。
11. 批次統計滿足加總不變式。
12. 貼文資料沒有離開本機，也沒有產品遙測。
13. Chrome 權限不超出核准基線。
14. 自動化 fixtures 與 live smoke test 均通過。
