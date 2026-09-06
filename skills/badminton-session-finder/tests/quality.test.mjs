import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateQuality } from "../scripts/validate.mjs";
import { writeJson, writeJsonl, readJson } from "../scripts/lib/io.mjs";
import { resultFor } from "./fixtures/analysis.mjs";

const id = "post_00000000000000000001";
const context = { text: "9/2（三）14:00-16:00 板橋羽球館，程度4-6級，費用250元，LINE：play_ball，報名表", reference_time: "2026-09-01T00:00:00Z", timezone: "Asia/Taipei", is_truncated: false };
test("quality gate never counts unreviewed real candidates as annotated acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "badminton-quality-"));
  const corpus = JSON.parse(await readFile(new URL("fixtures/quality-candidates.json", import.meta.url), "utf8"));
  assert.equal(corpus.samples.length, 30);
  assert.ok(corpus.samples.every((sample) => sample.review === null && sample.draft_expectation && !sample.acceptable_analyses.length));
  const samples = await writeJson(join(dir, "samples.json"), corpus);
  const results = await writeJsonl(join(dir, "results.jsonl"), []);
  const output = await evaluateQuality(samples, results, join(dir, "report.json"));
  assert.equal(output.passed, false); assert.equal(output.human_reviewed, 0);
  const report = await readJson(output.output);
  assert.ok(report.cases.every((item) => item.status === "awaiting_human_annotation"));
  assert.ok(Object.values(report.field_accuracy).every((metric) => metric.accuracy === null));
});

test("quality compares semantics beyond valid evidence and reports omissions and missing results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "badminton-quality-mismatch-"));
  const expected = resultFor({ id }, "line");
  const samples = await writeJson(join(dir, "samples.json"), { samples: [{ id, context, categories: ["single_session"], review: { reviewer: "synthetic unit-test label", confirmed_at: "2026-09-05T00:00:00Z" }, acceptable_analyses: [expected.analysis] }] });
  const wrong = structuredClone(expected); wrong.analysis.listings[0].price_options[0].amount = 999;
  const results = await writeJsonl(join(dir, "results.jsonl"), [wrong]);
  const result = await evaluateQuality(samples, results, join(dir, "report.json"));
  const report = await readJson(result.output);
  assert.equal(report.passed, false); assert.equal(report.cases[0].status, "semantic_mismatch");
  assert.deepEqual(report.cases[0].incorrect_fields, ["price_options"]);
  assert.equal(report.field_accuracy.price_options.accuracy, 0);
  await writeJsonl(results, [{ id, analysis: { is_recruitment: false, listings: [], warnings: ["not_recruitment"] } }]);
  await evaluateQuality(samples, results, join(dir, "report.json"));
  assert.equal((await readJson(join(dir, "report.json"))).missed_listings, 1);
});
