---
status: accepted
date: 2026-08-30
---

# 只使用頁面呈現資料

擷取器只讀取 Facebook 經正常頁面互動後呈現在 DOM 或可存取性資訊中的資料。自動捲動與展開「查看更多」可以觸發 Facebook 自身載入，但擴充功能不攔截、讀取、重放或自行組裝 Fetch、XHR、GraphQL、Cookie 或權杖資料；此邊界以欄位可能缺失與 DOM 變動風險，換取較小的權限面、可理解的資料來源及不依賴 Facebook 內部協定。
