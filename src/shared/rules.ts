export const DOM_RULES = {
  feed: ['[role="feed"]', '[data-pagelet="GroupFeed"]'],
  cards: ['[role="feed"] > [role="article"]', '[role="feed"] [role="article"]', '[data-pagelet="GroupFeed"] [role="article"]', '[data-fbgpe-card]'],
  content: [
    '[data-ad-rendering-role="story_message"]',
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-fbgpe-content]',
  ],
  author: ['[data-fbgpe-author]', '[data-ad-rendering-role="profile_name"] a[role="link"]', 'h2 a[role="link"]', 'h3 a[role="link"]', 'a[role="link"][href*="/user/"]', 'a[role="link"][href*="profile.php"]'],
  time: ['time', 'abbr[data-utime]', '[data-fbgpe-time]'],
  permalink: ['a[href*="/posts/"]', 'a[href*="permalink.php"]', 'a[href*="story_fbid="]'],
  seeMore: ['[data-fbgpe-see-more]', '[role="button"]'],
} as const;

export const TEXT_SIGNALS = {
  login: ["登入 Facebook", "Log into Facebook", "Log In"],
  accessDenied: ["目前無法查看此內容", "This content isn't available", "This content is not available", "私人社團", "Private group"],
  blocked: ["暫時封鎖", "你暫時無法使用此功能", "You're Temporarily Blocked", "We limit how often"],
  anonymous: ["匿名成員", "匿名參與者", "Anonymous member", "Anonymous participant"],
  pinned: ["置頂貼文", "精選貼文", "Pinned post", "Featured"],
  seeMore: ["顯示更多", "查看更多", "See more"],
  excluded: ["活動", "建立活動", "投票", "Reels", "分享了", "shared a", "Event", "Poll"],
  ignoredProgress: ["贊助", "Sponsored", "推薦", "Suggested for you", "系統訊息"],
} as const;

export const UNSUPPORTED_GROUP_SEGMENTS = new Set([
  "permalink", "posts", "search", "media", "members", "events", "files", "admin", "manage", "about"
]);
