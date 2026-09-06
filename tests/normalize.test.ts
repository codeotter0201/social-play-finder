import { describe, expect, it } from "vitest";
import { normalizeAbsoluteTime, normalizeCount } from "../src/shared/normalize";
import { normalizeUrl, parseGroupSource } from "../src/shared/url";

describe("normalization", () => {
  it.each([["1.2 萬", 12000], ["3K", 3000], ["1,234", 1234], ["not a number", null]])("normalizes display counts", (raw, expected) => expect(normalizeCount(raw)).toBe(expected));
  it("only normalizes explicit absolute times", () => {
    expect(normalizeAbsoluteTime("2026-08-30T10:00:00+08:00")).toBe("2026-08-30T02:00:00.000Z");
    expect(normalizeAbsoluteTime("3 hours ago")).toBeNull();
  });
  it("normalizes Facebook URLs without following redirects", () => {
    expect(normalizeUrl("https://m.facebook.com/groups/a/posts/1/?fbclid=x")).toBe("https://www.facebook.com/groups/a/posts/1/");
    expect(normalizeUrl("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.test%2Fx%3Fa%3D1&fbclid=x")).toBe("https://example.test/x?a=1");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("https://www.facebook.com/groups/1/posts/2/?__cft__%5B0%5D=secret&__tn__=x")).toBe("https://www.facebook.com/groups/1/posts/2/");
  });
  it("requires the canonical supported host for group source", () => {
    expect(parseGroupSource("https://www.facebook.com/groups/123/?sorting_setting=CHRONOLOGICAL")).toMatchObject({ groupId: "123", groupUrl: "https://www.facebook.com/groups/123/" });
    expect(parseGroupSource("https://web.facebook.com/groups/123/")).toBeNull();
  });
});
