import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { captureMissingPostHtml } from "../src/core/html-diagnostic";
import { parseCard } from "../src/core/parser";

describe("missing post URL diagnostics", () => {
  it("preserves the HTML at capture time losslessly through JSON, even if the live card changes", async () => {
    document.body.innerHTML = '<article><h3><a role="link" href="/groups/1/user/2/">作者</a></h3><div data-ad-preview="message">測試🏸</div><a href="/photo/?set=gm.123">圖片</a></article>';
    const card = document.querySelector("article")!;
    const post = parseCard(card, "https://www.facebook.com/groups/1/")!;
    expect(post.post_url).toBeNull();
    const original = card.outerHTML;
    const capture = captureMissingPostHtml(post, card);
    card.innerHTML = "changed";
    await capture;
    const saved = JSON.parse(JSON.stringify(post)).missing_post_url_html;
    expect(saved.encoding).toBe("gzip-base64");
    expect(gunzipSync(Buffer.from(saved.data, "base64")).toString("utf8")).toBe(original);
  });

  it("does not save HTML for posts with a known URL", async () => {
    document.body.innerHTML = '<article><a href="/groups/1/posts/123/">時間</a><div data-ad-preview="message">本文</div></article>';
    const card = document.querySelector("article")!;
    const post = parseCard(card, "https://www.facebook.com/groups/1/")!;
    await captureMissingPostHtml(post, card);
    expect(post.missing_post_url_html).toBeUndefined();
  });
});
