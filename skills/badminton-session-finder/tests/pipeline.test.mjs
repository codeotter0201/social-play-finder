import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { finalizeJoined } from "../scripts/finalize.mjs";
import { joinAnalysis } from "../scripts/join.mjs";
import { prepareSources } from "../scripts/prepare.mjs";
import { queryCsv } from "../scripts/query.mjs";
import { validateRun } from "../scripts/validate.mjs";
import { parseCsv, serializeCsv } from "../scripts/lib/csv.mjs";
import { readJson, readRecords, writeJson, writeJsonl } from "../scripts/lib/io.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const fixture = join(directory, "fixtures", "raw.json");

import { resultFor } from "./fixtures/analysis.mjs";

async function createRun() {
  const run = await mkdtemp(join(tmpdir(), "badminton-session-finder-"));
  await prepareSources([fixture], run);
  const tasks = await readRecords(join(run, "llm_tasks.jsonl"));
  const results = [resultFor(tasks[1], "line"), resultFor(tasks[0], "secret")];
  await writeJsonl(join(run, "llm_results.jsonl"), results);
  await joinAnalysis(join(run, "source_records.json"), join(run, "llm_results.jsonl"), join(run, "joined_records.json"));
  await finalizeJoined(join(run, "joined_records.json"), run);
  return { run, tasks, results };
}

test("raw -> id/context -> shuffled id join -> actionable JSON and CSV", async () => {
  const { run, tasks } = await createRun();
  assert.equal(tasks.length, 2);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ["context", "id"]);
  assert.deepEqual(Object.keys(tasks[0].context).sort(), ["is_truncated", "published_at", "reference_time", "reference_time_source", "scraped_at", "text", "timezone"]);
  assert.ok(!tasks[1].context.text.includes("https://example.com/register"));
  assert.match(tasks[1].context.text, /網址已由程式保留/u);

  const [raw, source, output, csvText] = await Promise.all([
    readJson(fixture),
    readJson(join(run, "source_records.json")),
    readJson(join(run, "output_result.json")),
    readFile(join(run, "output_result.csv"), "utf8"),
  ]);
  assert.deepEqual(source.batches[0].raw, raw.batch);
  assert.deepEqual(source.posts.map(({ raw: post }) => post), raw.posts);
  assert.deepEqual(output.source_posts.map(({ raw: post }) => post), raw.posts);
  assert.equal(output.listings.length, 2);
  const secret = output.listings.find(({ title }) => title === "秘密基地平日團");
  const direct = output.listings.find(({ title }) => title === "板橋羽球館臨打");
  assert.equal(secret.price_display, "原文未公開，請聯絡確認");
  assert.equal(secret.contact.contactability, "source");
  assert.equal(secret.contact.primary_url, raw.posts[0].post_url);
  assert.equal(direct.contact.contactability, "direct");
  assert.equal(direct.contact.registration_urls[0], "https://example.com/register?event=2");

  const parsed = parseCsv(csvText);
  assert.ok(parsed.headers.includes("author_url"));
  assert.ok(parsed.headers.includes("skill_description"));
  const secretRow = parsed.rows.find(({ title }) => title === "秘密基地平日團");
  assert.equal(secretRow.author_url, raw.posts[0].author_url);
  assert.equal(secretRow.skill_description, "不限程度，新手也歡迎");
  assert.equal(secretRow.primary_contact_url, raw.posts[0].post_url);
  assert.deepEqual(await validateRun(run), {
    run,
    batches: 1,
    posts: 2,
    results: 2,
    listings: 2,
    csv_rows: 2,
    partial: false,
  });
});

test("query applies grouped OR filters and returns contactable results", async () => {
  const { run } = await createRun();
  const planPath = join(run, "query.json");
  await writeJson(planPath, {
    interpretation: "9/2 或固定週三，開始時間不晚於 18:00（包含 18:00）",
    where: {
      all: [
        { any: [
          { field: "date", op: "eq", value: "2026-09-02" },
          { field: "recurrence_weekdays", op: "contains", value: 3 },
        ] },
        { field: "start_time", op: "lte", value: "18:00" },
      ],
    },
    preferences: { beginner_friendly: true, max_fee_twd: 300, require_contactable: true },
    include: { duplicates: false, full: false, cancelled: false },
  });
  const summary = await queryCsv(join(run, "output_result.csv"), planPath, join(run, "search_result.csv"));
  assert.equal(summary.total_groups, 2);
  const result = await readJson(summary.result);
  assert.equal(result.groups[0].primary.contactability, "direct");
  assert.ok(result.groups.some(({ primary }) => primary.primary_contact_url.includes("facebook.com")));
});

test("hard fee condition excludes unknown fees", async () => {
  const { run } = await createRun();
  const planPath = join(run, "query-fee.json");
  await writeJson(planPath, {
    interpretation: "費用不超過 300 元",
    where: { all: [{ field: "fee_max_twd", op: "lte", value: 300 }] },
    preferences: { beginner_friendly: null, max_fee_twd: 300, require_contactable: true },
    include: { duplicates: false, full: false, cancelled: false },
  });
  const summary = await queryCsv(join(run, "output_result.csv"), planPath, join(run, "fee.csv"));
  assert.equal(summary.total_groups, 1);
  const result = await readJson(summary.result);
  assert.equal(result.groups[0].primary.fee_max_twd, "250");
});

test("query returns every matching group without a result limit", async () => {
  const { run } = await createRun();
  const csvPath = join(run, "output_result.csv");
  const parsed = parseCsv(await readFile(csvPath, "utf8"));
  const seed = parsed.rows[0];
  const rows = Array.from({ length: 101 }, (_, index) => ({
    ...seed,
    listing_id: `listing_${index}`,
    event_group_id: `event_${index}`,
    dedupe_status: "unique",
  }));
  await writeFile(csvPath, serializeCsv(parsed.headers, rows.map((row) => parsed.headers.map((header) => row[header]))), "utf8");

  const planPath = join(run, "query-all.json");
  await writeJson(planPath, {
    interpretation: "全部符合場次",
    where: { all: [] },
    preferences: { beginner_friendly: null, max_fee_twd: null, require_contactable: false },
    include: { duplicates: false, full: false, cancelled: false },
  });

  const summary = await queryCsv(csvPath, planPath, join(run, "all.csv"));
  const result = await readJson(summary.result);
  assert.equal(summary.total_groups, 101);
  assert.equal(result.groups.length, 101);
  assert.ok(!("shown_groups" in summary));
  assert.ok(!("shown_groups" in result));
});

test("validate rejects cross-product drift and reports old output contracts explicitly", async () => {
  const { run } = await createRun();
  const csvPath = join(run, "output_result.csv");
  const original = await readFile(csvPath, "utf8");
  await writeFile(csvPath, original.replace("NT$250", "NT$999"));
  await assert.rejects(validateRun(run), /CSV differs from JSON/);
  await writeFile(csvPath, original);
  const reportPath = join(run, "run_report.json"); const report = await readJson(reportPath);
  await writeJson(reportPath, { ...report, publication_id: "wrong-generation" });
  await assert.rejects(validateRun(run), /Report differs/);
  await writeJson(reportPath, report);
  const page = join(run, "index.html"); const html = await readFile(page, "utf8");
  await writeFile(page, html.replace('"schema_version":"badminton-output-2"', '"schema_version":"wrong"'));
  await assert.rejects(validateRun(run), /Browser differs/);
  const legacy = await mkdtemp(join(tmpdir(), "badminton-legacy-output-"));
  await writeJson(join(legacy, "output_result.json"), { listings: [] });
  await assert.rejects(validateRun(legacy), /Old output contract.*revalidate\/re-extract/);
});
