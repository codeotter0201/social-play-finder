import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCard, findCards, findSeeMore, parseCard } from "../src/core/parser";
import { preflight } from "../src/core/preflight";
import { expandContent } from "../src/content/runner";

const fixture = (name: string) => readFileSync(resolve("tests/fixtures", name), "utf8");

describe("Facebook group DOM parser", () => {
  it("parses Traditional Chinese named, anonymous, pinned, metric and media fields", () => {
    document.documentElement.innerHTML = fixture("group-feed-zh.html");
    const checked = preflight(document, "https://www.facebook.com/groups/example/");
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.groupName).toBe("研究測試社團");
    expect(checked.cards).toHaveLength(5);
    const first = parseCard(checked.cards[0], checked.groupUrl, "2026-08-30T03:00:00.000Z")!;
    expect(first).toMatchObject({
      post_id: "10001", post_url: "https://www.facebook.com/groups/example/posts/10001/",
      author_name: "王小明", author_url: "https://www.facebook.com/profile.php?id=20001",
      is_anonymous: false, published_at: "2026-08-30T02:20:00.000Z", reaction_count: 12000,
      comment_count: 12, share_count: 3, is_pinned: true,
    });
    expect(first.content_text).toBe("第一行，測試資料。\n第二行含有 \"引號\"。");
    expect(first.media).toEqual([
      { type: "image", url: "https://scontent.xx.fbcdn.net/image.jpg" },
      { type: "link", url: "https://example.test/story?a=1" },
    ]);
    const anonymous = parseCard(checked.cards[1], checked.groupUrl)!;
    expect(anonymous).toMatchObject({ author_name: "匿名成員", author_url: null, is_anonymous: true, published_at: null });
    expect(anonymous.warnings).toContain("missing_post_identity");
    expect(anonymous.warnings).toContain("published_time_not_normalized");
    expect(classifyCard(checked.cards[2])).toBe("excluded");
    expect(classifyCard(checked.cards[3])).toBe("ignored");
  });

  it("parses English fields and recognizes excluded cards", () => {
    document.documentElement.innerHTML = fixture("group-feed-en.html");
    const cards = findCards(document);
    const post = parseCard(cards[0], "https://www.facebook.com/groups/research.test/")!;
    expect(post).toMatchObject({ post_id: "987654", reaction_count: 3000, comment_count: 24, share_count: 2 });
    expect(cards.slice(1).map(classifyCard)).toEqual(["excluded", "excluded"]);
  });

  it("keeps unsupported, login, access denial, and structural failures distinct", () => {
    document.body.innerHTML = '<form action="/login"><input type="password">Log into Facebook</form>';
    expect(preflight(document, "https://www.facebook.com/groups/example/")).toEqual({ ok: false, code: "not_logged_in" });
    document.body.innerHTML = "This content isn't available";
    expect(preflight(document, "https://www.facebook.com/groups/example/")).toEqual({ ok: false, code: "access_denied" });
    document.body.innerHTML = "ordinary page";
    expect(preflight(document, "https://www.facebook.com/groups/example/")).toEqual({ ok: false, code: "dom_changed" });
    expect(preflight(document, "https://www.facebook.com/groups/example/members/")).toEqual({ ok: false, code: "unsupported_page" });
  });

  it("does not classify ordinary post text as an excluded card", () => {
    document.body.innerHTML = `
      <article role="article">
        <a role="link" href="/groups/example/posts/123/">timestamp</a>
        <div data-ad-comet-preview="message">Weekend event and poll results / 週末活動投票結果</div>
      </article>`;
    expect(classifyCard(document.querySelector("article")!)).toBe("supported");
  });

  it("ignores generic feed containers that have no post evidence", () => {
    document.body.innerHTML = `
      <div role="feed">
        <article role="article" aria-label="Loading"><div role="status"></div></article>
      </div>`;
    expect(classifyCard(document.querySelector("article")!)).toBe("ignored");
  });

  it("keeps incomplete author-bearing cards visible as unknown failures", () => {
    document.body.innerHTML = `
      <article role="article">
        <h2><a role="link" href="/groups/example/user/42/">Test author</a></h2>
      </article>`;
    expect(classifyCard(document.querySelector("article")!)).toBe("unknown");
  });

  it("does not treat comment controls or comment permalinks as post content", () => {
    document.body.innerHTML = `
      <article role="article">
        <div data-ad-comet-preview="message">Visible post text</div>
        <button role="button">查看更多留言</button>
        <a href="/groups/example/posts/123/?comment_id=456">comment</a>
      </article>`;
    const card = document.querySelector("article")!;
    expect(findSeeMore(card)).toBeNull();
    expect(parseCard(card, "https://www.facebook.com/groups/example/")).toBeNull();
  });

  it("expands and parses the current story-message DOM", async () => {
    document.body.innerHTML = `
      <div role="feed">
        <div data-virtualized="false">
          <div data-ad-rendering-role="profile_name"><h2><a role="link" aria-label="Test author" href="/groups/example/user/42/">Test author</a></h2></div>
          <div data-ad-rendering-role="story_message">
            <span>這是截斷的主文</span>
            <div role="button" tabindex="0">顯示更多</div>
          </div>
          <a href="https://www.facebook.com/photo/?fbid=10&amp;set=pcb.123"><img src="https://scontent.example.test/post.jpg"></a>
          <div data-commentid="456">
            <div role="article" aria-label="Test commenter 的留言">
              <a role="link" href="/groups/example/user/99/">Test commenter</a>
              <a href="/groups/example/posts/123/?comment_id=456">1 小時</a>
              <div>這是留言內容</div>
            </div>
          </div>
        </div>
      </div>`;
    const cards = findCards(document);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    const button = card.querySelector<HTMLElement>("[role='button']")!;
    button.addEventListener("click", () => {
      card.querySelector("[data-ad-rendering-role='story_message']")!.replaceChildren("這是已經完整展開的主文內容");
    });

    await expandContent(card);
    const post = parseCard(card, "https://www.facebook.com/groups/example/");

    expect(post).toMatchObject({
      post_id: "123",
      post_url: "https://www.facebook.com/groups/example/posts/123/",
      author_name: "Test author",
      content_text: "這是已經完整展開的主文內容",
      content_is_truncated: false,
      media: [{ type: "image", url: "https://scontent.example.test/post.jpg" }],
    });
  });
});

it("does not mistake notification/chat headings for the group name", () => {
  document.head.innerHTML = '<title>(3) 台北羽球揪團 | Facebook</title>';
  document.body.innerHTML = '<h1>通知</h1><h1>聊天室</h1><div role="main"><h1><a href="/groups/123/">台北羽球揪團</a></h1><div role="feed"></div></div>';
  const result = preflight(document, "https://www.facebook.com/groups/123/");
  expect(result.ok && result.groupName).toBe("台北羽球揪團");
  document.body.innerHTML = '<h1>通知</h1><div role="feed"></div>';
  const fallback = preflight(document, "https://www.facebook.com/groups/123/");
  expect(fallback.ok && fallback.groupName).toBe("台北羽球揪團");
  document.head.innerHTML = '<title>Facebook</title>';
  const unknown = preflight(document, "https://www.facebook.com/groups/123/");
  expect(unknown.ok && unknown.groupName).toBe(null);
});
