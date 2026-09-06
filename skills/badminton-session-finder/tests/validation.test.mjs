import assert from "node:assert/strict";
import test from "node:test";
import { assertAnalysisMatchesSource, assertExtractionResult } from "../scripts/lib/validation.mjs";
import { buildSourceRecord } from "../scripts/prepare.mjs";
import { extractInlineUrls, maskInlineUrls } from "../scripts/lib/links.mjs";
import { resultFor } from "./fixtures/analysis.mjs";

const id = "post_00000000000000000001";
const text = "9/2（三）14:00-16:00 板橋羽球館，程度4-6級，費用250元，LINE：play_ball，報名表";
function valid() { return resultFor({ id }, "line"); }

test("A5: critical evidence paths, quotes, warnings, calendar and ranges reject invalid analysis", () => {
  assert.doesNotThrow(() => assertAnalysisMatchesSource(valid(), text));
  const cases = [
    ["empty evidence", (listing) => { listing.evidence = []; }, /missing field evidence/],
    ["invented quote", (listing) => { listing.evidence[0].quote = "fabricated"; }, /not present in source/],
    ["unfilled leaf", (listing) => { listing.evidence.push({ field: "venue.address", quote: "板橋" }); }, /actually filled leaf/],
    ["broad field", (listing) => { listing.evidence[0].field = "schedule"; }, /leaf/],
    ["unknown warning", (listing) => { listing.warnings = ["whatever_warning"]; }, /allowed values/],
    ["invalid date", (listing) => { listing.schedule.date = "2026-02-30"; }, /calendar date/],
    ["invalid time", (listing) => { listing.schedule.start_time = "25:00"; }, /pattern/],
    ["inverted time", (listing) => { listing.schedule.end_time = "13:00"; }, /overnight relationship/],
    ["inverted levels", (listing) => { listing.skill.min_level = 9; }, /min_level exceeds/],
    ["negative price", (listing) => { listing.price_options[0].amount = -1; }, /must be >= 0/],
    ["zero duration", (listing) => { listing.price_options[0].duration_minutes = 0; }, /must be >= 1/],
    ["legacy schedule", (listing) => { delete listing.schedule.end_day_offset; }, /Revalidate\/re-extract/],
    ["fabricated contact", (listing) => { listing.registration.line_id = "different"; }, /not present in source/],
  ];
  for (const [name, mutate, error] of cases) {
    const result = valid(); mutate(result.analysis.listings[0]);
    assert.throws(() => assertAnalysisMatchesSource(result, text), error, name);
  }
  const inconsistent = valid(); inconsistent.analysis.is_recruitment = false;
  assert.throws(() => assertExtractionResult(inconsistent), /must NOT have more than 0/);
});

test("A6: explicit next-day time and conditional prices preserve pairings and missing values", () => {
  const result = valid(); const listing = result.analysis.listings[0];
  listing.schedule.start_time = "23:00"; listing.schedule.end_time = "01:00"; listing.schedule.end_day_offset = 1;
  listing.price_options[0].condition = "男";
  listing.price_options.push({ amount: 200, currency: "TWD", duration_minutes: null, condition: "女" });
  for (const evidence of listing.evidence) if (["schedule.start_time", "schedule.end_time", "price_options.0.duration_minutes"].includes(evidence.field)) evidence.quote = "23:00至隔日01:00";
  listing.evidence.push({ field: "schedule.end_day_offset", quote: "隔日01:00" }, { field: "price_options.0.condition", quote: "男250" }, { field: "price_options.1.amount", quote: "女200" }, { field: "price_options.1.condition", quote: "女200" });
  assert.doesNotThrow(() => assertAnalysisMatchesSource(result, `${text}；23:00至隔日01:00，男250女200`));
  listing.schedule.end_day_offset = 0;
  assert.throws(() => assertAnalysisMatchesSource(result, `${text}；23:00至隔日01:00，男250女200`), /overnight relationship/);
  const missing = valid(); missing.analysis.listings[0].schedule.end_time = null;
  assert.throws(() => assertAnalysisMatchesSource(missing, text), /actually filled leaf|unknown start/);
});

test("A3,A4: time provenance never labels scrape time as publication and hash inputs include truncation", () => {
  const make = (rawPost) => buildSourceRecord({ id, batchId: "batch", sourceFile: "fixture", sourcePostIndex: 0, batch: { finished_at: "2026-09-01T10:00:00Z" }, rawPost });
  const fallback = make({ content_text: "今天羽球臨打", scraped_at: "not-a-time" });
  assert.equal(fallback.context.reference_time_source, "batch_finished_at");
  assert.equal(fallback.context.published_at, null); assert.equal(fallback.context.scraped_at, null);
  const reliable = make({ content_text: "今天羽球臨打", published_at: "2026-08-30T12:00:00Z", scraped_at: "2026-09-01T09:00:00Z", content_is_truncated: true });
  assert.equal(reliable.context.reference_time_source, "published_at");
  assert.equal(reliable.context.reference_time, "2026-08-30T12:00:00.000Z");
  assert.equal(reliable.context.scraped_at, "2026-09-01T09:00:00.000Z");
  assert.equal(reliable.context.is_truncated, true);
});

test("URL inventory preserves following Chinese punctuation and scheduling text", () => {
  const source = "報名 https://example.com/form?a=1；另18:00-20:00";
  assert.deepEqual(extractInlineUrls(source), ["https://example.com/form?a=1"]);
  assert.equal(maskInlineUrls(source), "報名 〔網址已由程式保留〕；另18:00-20:00");
});
