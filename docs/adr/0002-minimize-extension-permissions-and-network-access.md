---
status: accepted
date: 2026-08-30
---

# 最小化擴充功能權限與網路存取

MVP 權限基線限定為 activeTab、scripting、storage 與 downloads，不要求 cookies、webRequest、debugger、history、all_urls 或廣泛 Facebook host permission；同時不包含產品遙測、自有後端、遠端設定或遠端程式碼。這使擷取必須由使用者在目前分頁主動授權，並以工作階段暫存承擔較複雜的生命週期管理，換取較低的隱私風險與安裝授權成本；新增權限前必須修改需求並說明理由。
